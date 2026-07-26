"use strict";
// installer.js — one-shot CLI + importable module used by RVM
// desktop app's "Server" tab. It detects which optional/downloadable services
// are present, downloads/installs the missing ones, tracks what IT installed in
// a manifest, and can uninstall ONLY the things RVM itself installed (services
// that were already on the user's system are never removed).
//
// Usage (CLI):
//   node installer.js status          -> JSON status of all services
//   node installer.js install <id>    -> download/install one service
//   node installer.js uninstall <id>  -> uninstall one RVM-installed service
//   node installer.js uninstall-all   -> uninstall all RVM-installed services

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// RVM-owned directories: anything living here was put there by RVM and is safe
// to remove. Anything found elsewhere (system PATH, Program Files, apt/dnf) is
// treated as a pre-existing system install and is NOT uninstallable.
const RVM_HOME = path.join(os.homedir(), ".rvm");
const CLOUD_DEV_DIR = path.join(os.homedir(), ".cloud-dev");
const NOVNC_DIR = path.join(RVM_HOME, "novnc");
const VSCODE_CLI_DIR = path.join(RVM_HOME, "vscode-cli");
const VSCODE_CLI_DATA_DIR = path.join(RVM_HOME, "vscode-cli-data");
const TIGHTVNC_DIR = path.join(RVM_HOME, "tightvnc");
const GIT_DIR = path.join(RVM_HOME, "git");
const FFMPEG_DIR = path.join(RVM_HOME, "ffmpeg");
const MANIFEST = path.join(RVM_HOME, "installed.json");

// Pinned portable Windows builds used when no package manager (winget/choco)
// is available, so a clean machine still gets git/ffmpeg without admin rights.
const MINGIT_VERSION = "2.47.1";
const MINGIT_TAG = "v2.47.1.windows.1";
const FFMPEG_VERSION = "7.1";
const WINDOWS_DOWNLOAD_MIRROR_PREFIXES = [
  "https://ghfast.top/",
  "https://ghproxy.net/",
];
const WINDOWS_DOWNLOAD_MIN_BYTES = 100 * 1024;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

// ── Manifest (records what RVM installed & how, so we can uninstall it) ──────

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) || {}; } catch { return {}; }
}
function writeManifest(m) {
  try {
    if (!fs.existsSync(RVM_HOME)) fs.mkdirSync(RVM_HOME, { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  } catch (e) { log(`[manifest] write failed: ${e.message}`); }
}
function recordInstall(id, info) {
  const m = readManifest();
  m[id] = Object.assign({ at: new Date().toISOString() }, info || {});
  writeManifest(m);
}
function clearRecord(id) {
  const m = readManifest();
  delete m[id];
  writeManifest(m);
}

function isUnder(p, dir) {
  if (!p) return false;
  const rp = path.resolve(p).toLowerCase();
  const rd = path.resolve(dir).toLowerCase();
  return rp === rd || rp.startsWith(rd + path.sep);
}

// ── Detection ──────────────────────────────────────────────────────────────

function whichPath(cmd) {
  try {
    const tool = isWin ? "where" : "which";
    const r = spawnSync(tool, [cmd], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const p = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (p) return p;
    }
  } catch {}
  return null;
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

// Portable git.exe (prefer cmd/git.exe) fetched by RVM into ~/.rvm/git.
function portableGitExe() {
  const preferred = path.join(GIT_DIR, "cmd", "git.exe");
  if (fs.existsSync(preferred)) return preferred;
  return findFile(GIT_DIR, "git.exe");
}

// Portable ffmpeg.exe fetched by RVM into ~/.rvm/ffmpeg.
function portableFfmpegExe() {
  return findFile(FFMPEG_DIR, "ffmpeg.exe");
}

// MinGit ships sh.exe (the bash binary) but omits bash.exe. Some tools invoke
// `bash` by name (e.g. the Devin outpost shell integration used by
// devin-remote), so provide a bash.exe alongside sh.exe. Idempotent.
function ensurePortableBash() {
  if (!isWin) return;
  try {
    const sh = path.join(GIT_DIR, "usr", "bin", "sh.exe");
    const bash = path.join(GIT_DIR, "usr", "bin", "bash.exe");
    if (fs.existsSync(sh) && !fs.existsSync(bash)) fs.copyFileSync(sh, bash);
  } catch {}
}

// Directories to prepend to PATH so name-based git/bash/coreutils/ffmpeg calls
// resolve the RVM-managed portable builds. The Git usr/bin and mingw64/bin
// dirs come first so `bash` resolves to Git-for-Windows bash rather than the
// WSL stub in System32 (which has no distro installed). Consumed at startup.
function portableBinDirs() {
  const dirs = [];
  if (isWin) {
    const git = portableGitExe();
    if (git) {
      ensurePortableBash();
      for (const d of [
        path.join(GIT_DIR, "usr", "bin"),
        path.join(GIT_DIR, "mingw64", "bin"),
        path.dirname(git),
      ]) {
        if (fs.existsSync(d) && !dirs.includes(d)) dirs.push(d);
      }
    }
    const ff = portableFfmpegExe();
    if (ff) dirs.push(path.dirname(ff));
  }
  return dirs;
}

// Download a zip and extract it into destDir using Windows-native tools.
async function downloadZipWindows(logId, url, destDir) {
  const { runShell } = require("./core.js");
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const archive = path.join(destDir, "download.zip");
  const sources = [{ label: "direct", url }];
  const seen = new Set([url]);
  const addSource = (label, candidate) => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      sources.push({ label, url: candidate });
    }
  };
  try {
    const m = require("./gh-mirror.js").ghMirror(url);
    addSource("configured mirror", m);
  } catch {}
  for (const prefix of WINDOWS_DOWNLOAD_MIRROR_PREFIXES) {
    const wrapped = prefix.endsWith("/") ? prefix + url : `${prefix}/${url}`;
    addSource(`fallback mirror ${prefix}`, wrapped);
  }

  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const hasCurl = !!spawnSync("where", ["curl.exe"], { encoding: "utf8", windowsHide: true }).stdout;
  const download = (sourceUrl) => {
    if (hasCurl) {
      return runShell(
        `& curl.exe --fail --location --retry 3 --retry-all-errors --connect-timeout 30 --output ${psQuote(archive)} ${psQuote(sourceUrl)}`,
        undefined,
        600000,
      );
    }
    return runShell(
      `Invoke-WebRequest -Uri ${psQuote(sourceUrl)} -OutFile ${psQuote(archive)}`,
      undefined,
      600000,
    );
  };
  const extract = () => runShell(
    `Expand-Archive -Path ${psQuote(archive)} -DestinationPath ${psQuote(destDir)} -Force`,
    undefined,
    600000,
  );

  for (const source of sources) {
    try { fs.rmSync(archive, { force: true }); } catch {}
    log(`[${logId}] Trying ${source.label}: ${source.url}`);
    const result = await download(source.url);
    let size = 0;
    try { size = fs.statSync(archive).size; } catch {}
    if (result.exit_code !== 0 || size <= WINDOWS_DOWNLOAD_MIN_BYTES) {
      log(`[${logId}] ${source.label} failed: ${result.stderr || result.stdout || "download failed"} (size: ${size} bytes)`);
      try { fs.rmSync(archive, { force: true }); } catch {}
      continue;
    }
    const extracted = await extract();
    if (extracted.exit_code === 0) {
      try { fs.rmSync(archive, { force: true }); } catch {}
      log(`[${logId}] Downloaded and extracted via ${source.label}`);
      return true;
    }
    log(`[${logId}] ${source.label} extraction failed: ${extracted.stderr || extracted.stdout || "Expand-Archive failed"}`);
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(destDir, { recursive: true });
  }

  log(`[${logId}] All download sources failed`);
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
  return false;
}

function detectCloudflared() {
  const local = path.join(CLOUD_DEV_DIR, isWin ? "cloudflared.exe" : "cloudflared");
  if (fs.existsSync(local)) return { installed: true, detail: local, path: local };
  const onPath = whichPath("cloudflared");
  if (onPath) return { installed: true, detail: onPath, path: onPath };
  if (process.env.CLOUDFLARED && fs.existsSync(process.env.CLOUDFLARED)) {
    return { installed: true, detail: process.env.CLOUDFLARED, path: process.env.CLOUDFLARED };
  }
  return { installed: false };
}

function detectNoVnc() {
  const p = path.join(NOVNC_DIR, "vnc.html");
  return fs.existsSync(p) ? { installed: true, detail: NOVNC_DIR, path: NOVNC_DIR } : { installed: false };
}

function detectWebIde() {
  try {
    const cs = require("./code-server.js");
    if (isWin) {
      const exe = cs.findVscodeCliExe();
      return exe ? { installed: true, detail: exe, path: exe } : { installed: false };
    }
    const bin = cs.findCodeServer();
    return bin ? { installed: true, detail: bin, path: bin } : { installed: false };
  } catch (e) {
    return { installed: false, detail: e.message };
  }
}

function detectVncServer() {
  try {
    if (isMac) return { installed: true, detail: "built-in Screen Sharing", path: "" };
    if (isWin) {
      // RVM ships a single-file/portable TightVNC into its own cache dir; that
      // download isn't on PATH or in Program Files, so detectWindowsVnc misses
      // it. Check the RVM cache first so a portable install shows as installed
      // (and, being under the RVM dir, is correctly treated as RVM-managed).
      try {
        const portable = require("./tightvnc.js").findCached();
        if (portable) return { installed: true, detail: `TightVNC (portable): ${portable}`, path: portable };
      } catch { /* fall through to system detection */ }
    }
    const vs = require("./vnc-setup.js");
    const t = isWin ? vs.detectWindowsVnc() : vs.detectLinuxVnc();
    return t ? { installed: true, detail: String(t), path: "" } : { installed: false };
  } catch (e) {
    return { installed: false, detail: e.message };
  }
}

function detectFfmpeg() {
  if (isWin) {
    const portable = portableFfmpegExe();
    if (portable) return { installed: true, detail: `ffmpeg (portable): ${portable}`, path: portable };
  }
  const p = whichPath("ffmpeg");
  return p ? { installed: true, detail: p, path: p } : { installed: false };
}

function detectGit() {
  if (isWin) {
    const portable = portableGitExe();
    if (portable) return { installed: true, detail: `git (portable): ${portable}`, path: portable };
  }
  const p = whichPath("git");
  return p ? { installed: true, detail: p, path: p } : { installed: false };
}

function detectBrowser() {
  try {
    const core = require("./core.js");
    const bin = core.findChromeBinary && core.findChromeBinary();
    return bin ? { installed: true, detail: bin, path: bin } : { installed: false };
  } catch (e) {
    return { installed: false, detail: e.message };
  }
}

// managed == RVM installed it (lives in an RVM dir, or is recorded in manifest)
function isManaged(id, det, manifest) {
  if (manifest[id]) return true;
  const p = det && det.path;
  if (id === "cloudflared") return isUnder(p, CLOUD_DEV_DIR);
  if (id === "novnc") return isUnder(p, NOVNC_DIR);
  if (id === "web_ide") return isUnder(p, VSCODE_CLI_DIR);
  // On Windows RVM ships a single-file/portable TightVNC into its own cache dir.
  if (id === "vnc_server") return isUnder(p, TIGHTVNC_DIR);
  // On Windows RVM can fetch portable git/ffmpeg into its own cache dirs.
  if (id === "git") return isUnder(p, GIT_DIR);
  if (id === "ffmpeg") return isUnder(p, FFMPEG_DIR);
  return false; // otherwise only if in manifest
}

const SERVICES = {
  cloudflared: { name: "Cloudflare Tunnel (cloudflared)", detect: detectCloudflared },
  novnc: { name: "noVNC Web Client", detect: detectNoVnc },
  web_ide: { name: "Web IDE (VS Code / code-server)", detect: detectWebIde },
  vnc_server: { name: "VNC Server", detect: detectVncServer },
  ffmpeg: { name: "ffmpeg (Screen Recording)", detect: detectFfmpeg },
  git: { name: "Git", detect: detectGit },
  browser: { name: "Browser (Chrome / Edge, for CDP)", detect: detectBrowser },
};

function status() {
  const manifest = readManifest();
  const out = {};
  for (const [id, svc] of Object.entries(SERVICES)) {
    let r;
    try { r = svc.detect(); } catch (e) { r = { installed: false, detail: e.message }; }
    const managed = r.installed ? isManaged(id, r, manifest) : false;
    out[id] = {
      name: svc.name,
      installed: !!r.installed,
      detail: r.detail || "",
      source: r.installed ? (managed ? "rvm" : "system") : "",
      can_uninstall: !!managed,
    };
  }
  return out;
}

// ── Install ──────────────────────────────────────────────────────────────

function runInstallCmd(cmd, args) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 900000, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
  return r.status === 0;
}

async function installCloudflared() {
  const { downloadCloudflared } = require("./tunnel.js");
  const p = await downloadCloudflared(log);
  if (p) recordInstall("cloudflared", { method: "download", path: p });
  return !!p;
}

async function installNoVnc() {
  const novnc = require("./novnc.js");
  await novnc.ensureNoVnc(log);
  const ok = detectNoVnc().installed;
  if (ok) recordInstall("novnc", { method: "download", path: NOVNC_DIR });
  return ok;
}

async function installWebIde() {
  const cs = require("./code-server.js");
  const bin = isWin ? await cs.ensureVscodeCli(log) : await cs.installCodeServer(log);
  if (bin) recordInstall("web_ide", { method: isWin ? "download" : "script", path: String(bin) });
  return !!bin;
}

async function installVncServer() {
  if (isMac) {
    log("[vnc] macOS uses built-in Screen Sharing; nothing to install.");
    return detectVncServer().installed;
  }
  if (isWin) {
    // Windows ships a single-file/portable TightVNC into the RVM cache dir.
    // Fetch it now so it's present before start (and detected as RVM-managed).
    try {
      const exe = await require("./tightvnc.js").ensurePortableTightVnc(log);
      if (exe) log(`[vnc] Portable TightVNC ready: ${exe}`);
    } catch (e) { log(`[vnc] portable TightVNC download failed: ${e && e.message || e}`); }
    return detectVncServer().installed;
  }
  const vs = require("./vnc-setup.js");
  if (typeof vs.installLinuxVnc === "function") {
    try { vs.installLinuxVnc(log); } catch (e) { log(`[vnc] install failed: ${e.message}`); }
  }
  const ok = detectVncServer().installed;
  // installLinuxVnc installs x11vnc (apt, else yum/dnf) — record the real pkg so
  // a later uninstall removes the right thing.
  if (ok) {
    const method = whichPath("apt-get") ? "apt" : (whichPath("dnf") ? "dnf" : "");
    recordInstall("vnc_server", { method, pkg: "x11vnc" });
  }
  return ok;
}

async function installFfmpeg() {
  let method = "", pkg = "";
  if (isWin) {
    if (whichPath("winget")) { method = "winget"; pkg = "Gyan.FFmpeg"; runInstallCmd("winget", ["install", "--silent", "--accept-source-agreements", "--accept-package-agreements", "-e", "--id", pkg]); }
    else if (whichPath("choco")) { method = "choco"; pkg = "ffmpeg"; runInstallCmd("choco", ["install", "ffmpeg", "-y"]); }
    else {
      // No package manager: fetch a pinned portable ffmpeg build (no admin).
      log("[ffmpeg] No winget/choco; downloading portable ffmpeg...");
      const url = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`;
      try { fs.rmSync(FFMPEG_DIR, { recursive: true, force: true }); } catch {}
      if (await downloadZipWindows("ffmpeg", url, FFMPEG_DIR) && portableFfmpegExe()) {
        method = "portable"; recordInstall("ffmpeg", { method, path: FFMPEG_DIR });
      } else {
        log("[ffmpeg] Portable ffmpeg install failed.");
      }
    }
  } else if (isMac) {
    if (whichPath("brew")) { method = "brew"; pkg = "ffmpeg"; runInstallCmd("brew", ["install", "ffmpeg"]); }
    else log("[ffmpeg] Homebrew not available; install ffmpeg manually.");
  } else {
    if (whichPath("apt-get")) { method = "apt"; pkg = "ffmpeg"; runInstallCmd("sudo", ["apt-get", "install", "-y", "ffmpeg"]) || runInstallCmd("apt-get", ["install", "-y", "ffmpeg"]); }
    else if (whichPath("dnf")) { method = "dnf"; pkg = "ffmpeg"; runInstallCmd("sudo", ["dnf", "install", "-y", "ffmpeg"]); }
    else log("[ffmpeg] No supported package manager found; install ffmpeg manually.");
  }
  const ok = detectFfmpeg().installed;
  if (ok && method) recordInstall("ffmpeg", { method, pkg });
  return ok;
}

async function installGit() {
  let method = "", pkg = "";
  if (isWin) {
    if (whichPath("winget")) { method = "winget"; pkg = "Git.Git"; runInstallCmd("winget", ["install", "--silent", "--accept-source-agreements", "--accept-package-agreements", "-e", "--id", pkg]); }
    else if (whichPath("choco")) { method = "choco"; pkg = "git"; runInstallCmd("choco", ["install", "git", "-y"]); }
    else {
      // No package manager: fetch the official MinGit portable build (no admin).
      log("[git] No winget/choco; downloading portable MinGit...");
      const bits = process.arch === "ia32" ? "32" : "64";
      const url = `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/MinGit-${MINGIT_VERSION}-${bits}-bit.zip`;
      try { fs.rmSync(GIT_DIR, { recursive: true, force: true }); } catch {}
      if (await downloadZipWindows("git", url, GIT_DIR) && portableGitExe()) {
        ensurePortableBash();
        method = "portable"; recordInstall("git", { method, path: GIT_DIR });
      } else {
        log("[git] Portable MinGit install failed.");
      }
    }
  } else if (isMac) {
    if (whichPath("brew")) { method = "brew"; pkg = "git"; runInstallCmd("brew", ["install", "git"]); }
    else log("[git] Homebrew not available; install Git manually.");
  } else {
    if (whichPath("apt-get")) { method = "apt"; pkg = "git"; runInstallCmd("sudo", ["apt-get", "install", "-y", "git"]) || runInstallCmd("apt-get", ["install", "-y", "git"]); }
    else if (whichPath("dnf")) { method = "dnf"; pkg = "git"; runInstallCmd("sudo", ["dnf", "install", "-y", "git"]); }
    else log("[git] No supported package manager found; install Git manually.");
  }
  const ok = detectGit().installed;
  if (ok && method) recordInstall("git", { method, pkg });
  return ok;
}

async function installBrowser() {
  let method = "", pkg = "";
  if (isWin) {
    if (whichPath("winget")) { method = "winget"; pkg = "Google.Chrome"; runInstallCmd("winget", ["install", "--silent", "--accept-source-agreements", "--accept-package-agreements", "-e", "--id", pkg]); }
    else if (whichPath("choco")) { method = "choco"; pkg = "googlechrome"; runInstallCmd("choco", ["install", "googlechrome", "-y"]); }
    else log("[browser] Neither winget nor choco available; install Chrome/Edge manually.");
  } else if (isMac) {
    if (whichPath("brew")) { method = "brew"; pkg = "google-chrome"; runInstallCmd("brew", ["install", "--cask", "google-chrome"]); }
    else log("[browser] Homebrew not available; install a browser manually.");
  } else {
    if (whichPath("apt-get")) { method = "apt"; pkg = "chromium-browser"; (runInstallCmd("sudo", ["apt-get", "install", "-y", "chromium-browser"]) || (pkg = "chromium", runInstallCmd("sudo", ["apt-get", "install", "-y", "chromium"]))); }
    else if (whichPath("dnf")) { method = "dnf"; pkg = "chromium"; runInstallCmd("sudo", ["dnf", "install", "-y", "chromium"]); }
    else log("[browser] No supported package manager found; install a browser manually.");
  }
  const ok = detectBrowser().installed;
  if (ok && method) recordInstall("browser", { method, pkg });
  return ok;
}

const INSTALLERS = {
  cloudflared: installCloudflared,
  novnc: installNoVnc,
  web_ide: installWebIde,
  vnc_server: installVncServer,
  ffmpeg: installFfmpeg,
  git: installGit,
  browser: installBrowser,
};

async function install(id) {
  const fn = INSTALLERS[id];
  if (!fn) throw new Error(`unknown service: ${id}`);
  // Skip anything already present — don't re-download. A service RVM already
  // fetched (e.g. the portable TightVNC under ~/.rvm/tightvnc) or a
  // pre-existing system install is left as-is. (Skipping a system install also
  // avoids adopting it into the manifest, which a later uninstall would trust.)
  try {
    const st = status()[id];
    if (st && st.installed) {
      log(`[install] ${id} already present (${st.source || "installed"}) — skipping install.`);
      return true;
    }
  } catch {}
  return await fn();
}

// ── Uninstall (only RVM-installed items; system installs are never touched) ──

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log(`[uninstall] rm ${p} failed: ${e.message}`); } }

function pkgUninstall(rec) {
  const pkg = rec.pkg;
  if (!pkg) return true;
  switch (rec.method) {
    case "winget": return runInstallCmd("winget", ["uninstall", "--silent", "--accept-source-agreements", "-e", "--id", pkg]);
    case "choco": return runInstallCmd("choco", ["uninstall", pkg, "-y"]);
    case "brew": return runInstallCmd("brew", ["uninstall", pkg]) || runInstallCmd("brew", ["uninstall", "--cask", pkg]);
    case "apt": return runInstallCmd("sudo", ["apt-get", "remove", "-y", pkg]) || runInstallCmd("apt-get", ["remove", "-y", pkg]);
    case "dnf": return runInstallCmd("sudo", ["dnf", "remove", "-y", pkg]);
    default: return true;
  }
}

async function uninstall(id) {
  const manifest = readManifest();
  const st = status()[id];
  if (!st || !st.installed) { clearRecord(id); return true; }
  if (!st.can_uninstall) {
    log(`[uninstall] ${id} is a pre-existing system install — not removing.`);
    return false;
  }
  const rec = manifest[id] || {};
  switch (id) {
    case "cloudflared": rmrf(path.join(CLOUD_DEV_DIR, isWin ? "cloudflared.exe" : "cloudflared")); break;
    case "novnc": rmrf(NOVNC_DIR); break;
    case "web_ide":
      rmrf(VSCODE_CLI_DIR);
      rmrf(VSCODE_CLI_DATA_DIR);
      break;
    case "vnc_server":
      // Windows: RVM's portable TightVNC lives in its own cache dir. Linux:
      // x11vnc was installed via a package manager (recorded in the manifest).
      if (isWin && isUnder(st.path, TIGHTVNC_DIR)) rmrf(TIGHTVNC_DIR);
      else pkgUninstall(rec);
      break;
    case "git":
      // Windows portable MinGit lives in the RVM cache dir; otherwise pkg mgr.
      if (isWin && isUnder(st.path, GIT_DIR)) rmrf(GIT_DIR);
      else pkgUninstall(rec);
      break;
    case "ffmpeg":
      // Windows portable ffmpeg lives in the RVM cache dir; otherwise pkg mgr.
      if (isWin && isUnder(st.path, FFMPEG_DIR)) rmrf(FFMPEG_DIR);
      else pkgUninstall(rec);
      break;
    default:
      // browser was installed via a package manager
      pkgUninstall(rec);
      break;
  }
  const after = status()[id];
  if (!after.installed) {
    clearRecord(id);
    return true;
  }
  // Removal did not take effect (e.g. `sudo apt-get remove` needs a password/tty
  // that isn't available). Keep the manifest record so the item stays
  // uninstallable and the user can retry, rather than reporting a false success.
  log(`[uninstall] ${id}: removal did not complete — keeping install record so it stays uninstallable.`);
  return false;
}

async function uninstallAll() {
  const st = status();
  const results = {};
  for (const id of Object.keys(SERVICES)) {
    if (st[id] && st[id].can_uninstall) {
      try { results[id] = await uninstall(id); } catch (e) { log(`[uninstall] ${id}: ${e.message}`); results[id] = false; }
    }
  }
  return results;
}

module.exports = { SERVICES, status, install, uninstall, uninstallAll, log, portableBinDirs };

// ── CLI ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const [, , action, arg] = process.argv;
    if (action === "status") {
      process.stdout.write(JSON.stringify(status()));
      process.exit(0);
    }
    if (action === "install") {
      let ok = false;
      try { ok = await install(arg); } catch (e) { log(`install error: ${e && e.stack || e}`); ok = false; }
      process.stdout.write(JSON.stringify({ ok, id: arg, status: status()[arg] }));
      process.exit(ok ? 0 : 1);
    }
    if (action === "uninstall") {
      let ok = false;
      try { ok = await uninstall(arg); } catch (e) { log(`uninstall error: ${e && e.stack || e}`); ok = false; }
      process.stdout.write(JSON.stringify({ ok, id: arg, status: status()[arg] }));
      process.exit(ok ? 0 : 1);
    }
    if (action === "uninstall-all") {
      const results = await uninstallAll();
      process.stdout.write(JSON.stringify({ ok: true, results, status: status() }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ error: "usage: installer.js status|install <id>|uninstall <id>|uninstall-all" }));
    process.exit(1);
  })();
}

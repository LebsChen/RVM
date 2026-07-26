"use strict";
// code-server integration — Web VS Code IDE
// Auto-detects or installs code-server, manages lifecycle, proxies HTTP
// Cloud-Dev accesses via /ide/ endpoint

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const net = require("net");
const { ghMirror } = require("./gh-mirror.js");

const isWin = process.platform === "win32";
const VSCODE_CLI_DIR = path.join(os.homedir(), ".rvm", "vscode-cli");
const VSCODE_CLI_DATA_DIR = path.join(os.homedir(), ".rvm", "vscode-cli-data");
// Self-hosted mirror of the Devin-built VS Code CLI + serve-web server. Fetching
// from here (optionally via GITHUB_MIRROR / gh-proxy) is far faster than the
// Microsoft CDN, and lets us pre-provision the serve-web server so the first
// connection does not have to download ~150MB on demand.
const VSCODE_DIST_BASE = "https://github.com/LebsChen/vscode-dist/releases/download/latest";
// Dedicated VS Code user-data dir so we can pre-seed settings that grant the
// Web IDE full-machine access (workspace trust off = no Restricted Mode).
const VSCODE_USER_DIR = path.join(os.homedir(), ".rvm", "vscode-user");
let serveWebBasePathMode = false;

// Devin's own Web IDE (`code serve-web`) config, taken verbatim from the Devin
// box (…/vscode-serve-web-data/server_data/data/Machine/settings.json). Using
// the same file makes RVM's Web IDE behave like Devin's instead of a raw
// default profile.
const DEVIN_VSCODE_SETTINGS = {
  "editor.scrollBeyondLastLine": true,
  "files.trimTrailingWhitespace": true,
  "files.insertFinalNewline": true,
  "editor.fontSize": 12,
  "editor.wordWrap": "on",
  "files.exclude": { "**/.git": true, "**/.svn": true, "**/.hg": true },
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.startupEditor": "readme",
  "basedpyright.analysis.typeCheckingMode": "basic",
  "window.commandCenter": false,
};

// Build the effective settings: RVM-required trust/speed defaults first, then
// Devin's own settings on top (Devin's values win for any shared key).
function buildVscodeSettings(existing) {
  const settings = { ...(existing || {}) };
  // RVM requirement: no Restricted Mode / workspace-trust prompt so the Web IDE
  // can read/write the whole machine.
  settings["security.workspace.trust.enabled"] = false;
  settings["security.workspace.trust.startupPrompt"] = "never";
  settings["security.workspace.trust.banner"] = "never";
  settings["security.workspace.trust.untrustedFiles"] = "open";
  settings["window.restoreWindows"] = "none";
  // Kill the startup network round-trips that make a fresh serve-web profile
  // load slowly (telemetry / experiments / update+marketplace checks / sync).
  settings["telemetry.telemetryLevel"] = "off";
  settings["workbench.enableExperiments"] = false;
  settings["workbench.settings.enableNaturalLanguageSearch"] = false;
  settings["update.mode"] = "none";
  settings["extensions.autoCheckUpdates"] = false;
  settings["extensions.autoUpdate"] = false;
  settings["npm.fetchOnlinePackageInfo"] = false;
  settings["git.autofetch"] = false;
  // Devin's own config wins.
  return { ...settings, ...DEVIN_VSCODE_SETTINGS };
}

function writeSettingsFile(file, log) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    if (fs.existsSync(file)) {
      try { existing = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
    }
    fs.writeFileSync(file, JSON.stringify(buildVscodeSettings(existing), null, 2));
  } catch (e) {
    if (log) log(`[code-server] could not seed VS Code settings (${file}): ${e.message}`);
  }
}

// Pre-seed VS Code settings so the Web IDE uses Devin's config and skips the
// Restricted Mode prompt. Writes every layout so it applies to both
// `code serve-web` (Windows: <data-dir>/data/{Machine,User}/settings.json) and
// coder `code-server` (<user-data-dir>/User/settings.json). Returns the dir to
// pass as --server-data-dir / --user-data-dir.
function seedVscodeUserSettings(log) {
  writeSettingsFile(path.join(VSCODE_USER_DIR, "data", "Machine", "settings.json"), log);
  writeSettingsFile(path.join(VSCODE_USER_DIR, "data", "User", "settings.json"), log);
  writeSettingsFile(path.join(VSCODE_USER_DIR, "User", "settings.json"), log);
  return VSCODE_USER_DIR;
}

let codeServerProc = null;
let codeServerPort = 0;
let codeServerPassword = "";
let serveWebProductConfiguration = null;

// ── Find or install code-server ───────────────────────────────────────────

function findCodeServer() {
  // Linux always starts the Devin CLI serve-web path below. Do not report a
  // legacy code-server from PATH as installed when start() would ignore it.
  if (!isWin) return findVscodeCliExe();

  // Check PATH
  const names = isWin ? ["code-server.cmd", "code-server.exe", "code-server"] : ["code-server"];
  for (const name of names) {
    try {
      const cmd = isWin ? "where" : "which";
      const result = execFileSync(cmd, [name], { encoding: "utf8", timeout: 5000 });
      const p = result.trim().split("\n")[0];
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }

  // Check common install locations
  const locations = isWin
    ? [
        path.join(process.env.PROGRAMFILES || "C:\\Program Files", "code-server", "bin", "code-server.cmd"),
        path.join(os.homedir(), ".local", "bin", "code-server.cmd"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "code-server", "bin", "code-server.cmd"),
      ]
    : [
        "/usr/bin/code-server",
        "/usr/local/bin/code-server",
        path.join(os.homedir(), ".local", "bin", "code-server"),
        path.join(os.homedir(), ".local", "lib", "code-server", "bin", "code-server"),
      ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }

  return null;
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
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

function findVscodeCliExe() {
  const cached = findFile(VSCODE_CLI_DIR, isWin ? "code.exe" : "code");
  if (cached) return cached;
  return null;
}

function vscodeDistAssets() {
  return isWin
    ? { cli: "devin-cli-win32-x64.zip", server: "devin-server-win32-x64-web.zip" }
    : { cli: "devin-cli-linux-x64.tar.gz", server: "devin-server-linux-x64-web.tar.gz" };
}

async function ensureVscodeCli(log) {
  const cached = findVscodeCliExe();
  if (cached) return cached;
  if (!fs.existsSync(VSCODE_CLI_DIR)) fs.mkdirSync(VSCODE_CLI_DIR, { recursive: true });

  const { cli } = vscodeDistAssets();
  const url = ghMirror(`${VSCODE_DIST_BASE}/${cli}`);
  const archive = path.join(VSCODE_CLI_DIR, cli);
  log(`[code-server] Downloading Devin VS Code CLI...`);
  const { runShell } = require("./core.js");
  const command = isWin
    ? `Invoke-WebRequest -Uri "${url}" -OutFile "${archive}"; Expand-Archive -Path "${archive}" -DestinationPath "${VSCODE_CLI_DIR}" -Force`
    : `curl -fL "${url}" -o "${archive}" && tar xzf "${archive}" -C "${VSCODE_CLI_DIR}" && chmod +x "${path.join(VSCODE_CLI_DIR, "code")}"`;
  const r = await runShell(command, undefined, 300000);
  if (r.exit_code !== 0) {
    log(`[code-server] VS Code CLI download failed: ${r.stderr || r.stdout}`);
    return null;
  }
  try { fs.rmSync(archive, { force: true }); } catch {}
  return findVscodeCliExe();
}

// Resolve the 40-char commit the CLI is built from (serve-web caches its server
// under <cli-data-dir>/serve-web/<commit>/).
function vscodeCliCommit(bin) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
    const m = out.match(/\(commit\s+([0-9a-f]{40})\)/i) || out.match(/\b([0-9a-f]{40})\b/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Pre-provision the serve-web server so `code serve-web` uses our mirrored copy
// instead of downloading it from Microsoft on first connect. The Devin CLI is
// an OSS build with no server download URL, so this step is what makes the Web
// IDE start without a slow (or impossible) on-demand server download.
async function ensureServeWebServer(bin, log) {
  const commit = vscodeCliCommit(bin);
  if (!commit) {
    log("[code-server] could not resolve CLI commit; leaving serve-web to self-provision");
    return;
  }
  const serveWebDir = path.join(VSCODE_CLI_DATA_DIR, "serve-web", commit);
  if (fs.existsSync(path.join(serveWebDir, "product.json"))) return; // already present

  const { server } = vscodeDistAssets();
  const url = ghMirror(`${VSCODE_DIST_BASE}/${server}`);
  const archive = path.join(VSCODE_CLI_DIR, server);
  const tmp = path.join(VSCODE_CLI_DIR, "server-extract");
  log("[code-server] Pre-provisioning Devin serve-web server...");
  const { runShell } = require("./core.js");
  const command = isWin
    ? [
        `Invoke-WebRequest -Uri "${url}" -OutFile "${archive}"`,
        `if (Test-Path "${tmp}") { Remove-Item -Recurse -Force "${tmp}" }`,
        `Expand-Archive -Path "${archive}" -DestinationPath "${tmp}" -Force`,
        `$dirs = @(Get-ChildItem "${tmp}" -Directory)`,
        `if ($dirs.Count -ne 1) { throw "Expected one server archive directory, found $($dirs.Count)" }`,
        `New-Item -ItemType Directory -Force -Path "${serveWebDir}" | Out-Null`,
        `Copy-Item -Path (Join-Path $dirs[0].FullName '*') -Destination "${serveWebDir}" -Recurse -Force`,
        `Remove-Item -Recurse -Force "${tmp}"`,
      ].join("; ")
    : [
        `rm -rf "${tmp}"`,
        `mkdir -p "${tmp}"`,
        `curl -fL "${url}" -o "${archive}"`,
        `tar xzf "${archive}" -C "${tmp}"`,
        `inner_count=$(find "${tmp}" -mindepth 1 -maxdepth 1 -type d | wc -l)`,
        `[ "$inner_count" -eq 1 ] || { echo "Expected one server archive directory, found $inner_count" >&2; exit 1; }`,
        `inner=$(find "${tmp}" -mindepth 1 -maxdepth 1 -type d -print -quit)`,
        `mkdir -p "${serveWebDir}"`,
        `cp -a "$inner"/. "${serveWebDir}"/`,
        `rm -rf "${tmp}"`,
      ].join(" && ");
  const r = await runShell(command, undefined, 600000);
  if (r.exit_code !== 0) {
    log(`[code-server] serve-web server provision failed: ${r.stderr || r.stdout}`);
  } else {
    try { fs.rmSync(archive, { force: true }); } catch {}
    log("[code-server] serve-web server ready (mirrored)");
  }
}

async function installCodeServer(log) {
  log("[code-server] Not found, attempting install...");
  return ensureVscodeCli(log);
}

function httpGetStatus(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    }).on("error", reject);
  });
}

async function probeServeWeb(port, connectionToken) {
  if (!port) return false;
  const tokenQuery = connectionToken ? `?tkn=${encodeURIComponent(connectionToken)}` : "";
  try {
    const status = await httpGetStatus(`http://127.0.0.1:${port}/ide/${tokenQuery}`);
    return status >= 200 && status < 400;
  } catch {
    return false;
  }
}

function findPidsOnPort(port) {
  try {
    if (isWin) {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 10000, windowsHide: true });
      const pids = new Set();
      for (const line of out.split("\n")) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
      return [...pids];
    }
    const out = execFileSync("sh", ["-c", `lsof -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`], { encoding: "utf8", timeout: 10000 });
    return out.split("\n").map((s) => Number(s.trim())).filter(Boolean);
  } catch {
    return [];
  }
}

function pidCommandLine(pid) {
  try {
    if (isWin) {
      const out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], { encoding: "utf8", timeout: 10000, windowsHide: true });
      return out;
    }
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 });
  } catch {
    return "";
  }
}

function isServeWebProcess(pid) {
  const cmd = pidCommandLine(pid).toLowerCase();
  return cmd.includes("serve-web") || /\bcode(\.exe)?\b/.test(cmd);
}

function killPids(pids, log) {
  for (const pid of pids) {
    try {
      if (isWin) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
      else process.kill(pid, "SIGKILL");
      log(`[code-server] killed stale serve-web process ${pid}`);
    } catch {}
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function startServeWeb(port, workspace, log, allowDownload = true, connectionToken = "") {
  let bin = findVscodeCliExe();
  if (!bin) {
    if (!allowDownload) {
      serveWebBasePathMode = false;
      return { ok: false, error: "VS Code CLI not installed and auto-install disabled for Web IDE" };
    }
    bin = await ensureVscodeCli(log);
  }
  if (!bin) {
    serveWebBasePathMode = false;
    return { ok: false, error: "VS Code CLI not found and download failed" };
  }

  // Make sure the serve-web server is present (mirrored) before we start, so the
  // first connection doesn't stall on a Microsoft-CDN server download.
  if (allowDownload) {
    try { await ensureServeWebServer(bin, log); } catch (e) { log(`[code-server] server pre-provision error: ${e.message}`); }
  } else {
    const commit = vscodeCliCommit(bin);
    const serverDir = commit
      ? path.join(VSCODE_CLI_DATA_DIR, "serve-web", commit)
      : "";
    if (!commit || !fs.existsSync(path.join(serverDir, "product.json"))) {
      serveWebBasePathMode = false;
      return {
        ok: false,
        error: "VS Code serve-web server is not pre-provisioned and auto-install is disabled",
      };
    }
  }

  codeServerPort = port;
  codeServerPassword = "";

  // serve-web does not accept --user-data-dir (that's a desktop `code` flag);
  // passing it makes the CLI exit with code 2. It keeps its own state under
  // --server-data-dir instead. We still pre-seed settings there so the Web IDE
  // opens without the Restricted Mode / workspace-trust prompt.
  const serverDataDir = seedVscodeUserSettings(log);
  const args = [
    "serve-web",
    "--port", String(codeServerPort),
    "--host", "127.0.0.1",
    "--server-base-path", "/ide",
    // Gate the Web IDE behind the unified RVM token. With no token (e.g. local
    // dev), the CLI rejects an empty --connection-token, so fall back to open.
    ...(connectionToken ? ["--connection-token", connectionToken] : ["--without-connection-token"]),
    "--accept-server-license-terms",
    "--server-data-dir", serverDataDir,
    "--cli-data-dir", VSCODE_CLI_DATA_DIR,
  ];
  serveWebBasePathMode = true;

  log(`[code-server] Starting VS Code CLI serve-web on port ${codeServerPort} (workspace: ${workspace || "~"})`);
  try {
    codeServerProc = spawn(bin, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      cwd: path.dirname(bin),
      env: { ...process.env },
    });
    codeServerProc.unref();
  } catch (e) {
    serveWebBasePathMode = false;
    log(`[code-server] spawn failed: ${e.message}`);
    return { ok: false, error: `spawn failed: ${e.message}` };
  }

  codeServerProc.on("error", (err) => {
    log(`[code-server] process error: ${err.message}`);
    codeServerProc = null;
    serveWebBasePathMode = false;
  });
  codeServerProc.on("exit", (code) => {
    log(`[code-server] exited code=${code}`);
    codeServerProc = null;
    serveWebBasePathMode = false;
  });

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const tokenQuery = connectionToken ? `?tkn=${encodeURIComponent(connectionToken)}` : "";
      const status = await httpGetStatus(`http://127.0.0.1:${codeServerPort}/ide/${tokenQuery}`);
      if (status >= 200 && status < 400) {
        log(`[code-server] Web UI available at http://127.0.0.1:${codeServerPort}/ide/`);
        return { ok: true, port: codeServerPort, pid: codeServerProc ? codeServerProc.pid : null };
      }
    } catch {}
    if (!codeServerProc) break;
  }

  try { if (codeServerProc) codeServerProc.kill(); } catch {}
  codeServerProc = null;
  serveWebBasePathMode = false;
  return { ok: false, error: "VS Code serve-web did not become ready in 90s" };
}

// ── Start code-server ─────────────────────────────────────────────────────

async function start(port, password, workspace, log, opts = {}) {
  const allowDownload = opts.allowDownload !== false;
  const connectionToken = opts.connectionToken || "";
  if (codeServerProc) {
    // Never report ok on a tracked process that is not actually serving.
    if (await probeServeWeb(codeServerPort, connectionToken)) {
      return { ok: true, port: codeServerPort, already: true };
    }
    log("[code-server] tracked process is not serving; restarting");
    stop(log);
  }

  // The target port may be held by a serve-web left over from a previous agent
  // run: adopt it if healthy, kill it if broken, and only fall back to another
  // port when an unrelated process owns it.
  const stalePids = findPidsOnPort(port);
  if (stalePids.length) {
    if (await probeServeWeb(port, connectionToken)) {
      codeServerPort = port;
      codeServerPassword = "";
      serveWebBasePathMode = true;
      codeServerProc = { adopted: true, pid: stalePids[0], kill: () => killPids(stalePids, log) };
      log(`[code-server] adopted existing serve-web on port ${port} (pid ${stalePids.join(",")})`);
      return { ok: true, port, pid: stalePids[0], adopted: true };
    }
    const serveWebPids = stalePids.filter((pid) => isServeWebProcess(pid));
    if (serveWebPids.length) {
      log(`[code-server] port ${port} held by stale serve-web process(es) ${serveWebPids.join(",")}; cleaning up`);
      killPids(serveWebPids, log);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await portIsFree(port))) {
      for (let p = port + 1; p < port + 20; p++) {
        if (await portIsFree(p)) {
          log(`[code-server] port ${port} unavailable; using ${p}`);
          port = p;
          break;
        }
      }
    }
  }

  return startServeWeb(port, workspace, log, allowDownload, connectionToken);
}

function stop(log) {
  if (codeServerProc) {
    try { codeServerProc.kill(); } catch {}
    codeServerProc = null;
    serveWebBasePathMode = false;
    log("[code-server] Stopped");
  }
}

function readServeWebToken() {
  const candidates = [
    path.join(VSCODE_CLI_DATA_DIR, "serve-web-token"),
    path.join(os.homedir(), ".rvm", "vscode-cli-data", "serve-web-token"),
    "/root/.rvm/vscode-cli-data/serve-web-token",
    "/tmp/serve-web-token",
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const token = fs.readFileSync(file, "utf8").trim();
        if (token) return token;
      }
    } catch {}
  }
  return "";
}

function tryAdoptExistingServeWeb() {
  if (codeServerProc && codeServerPort) return true;
  const candidatePorts = [9877, 9876, 8080];
  for (const p of candidatePorts) {
    const pids = findPidsOnPort(p);
    if (pids.length > 0) {
      codeServerPort = p;
      codeServerPassword = "";
      serveWebBasePathMode = true;
      codeServerProc = {
        adopted: true,
        pid: pids[0],
        kill: () => killPids(pids, () => {}),
      };
      return true;
    }
  }
  return false;
}

// Re-check that the tracked/adopted serve-web still answers HTTP.
async function healthCheck(connectionToken) {
  if (!codeServerProc || !codeServerPort) {
    if (!tryAdoptExistingServeWeb()) return false;
  }
  return probeServeWeb(codeServerPort, connectionToken || readServeWebToken() || "");
}

function getPort() {
  if (!codeServerPort) tryAdoptExistingServeWeb();
  return codeServerPort || 9877;
}
function getPassword() { return codeServerPassword; }
function isRunning() {
  if (codeServerProc && codeServerPort) return true;
  return tryAdoptExistingServeWeb();
}

function loadServeWebProductConfiguration() {
  if (serveWebProductConfiguration) return serveWebProductConfiguration;
  const bin = findVscodeCliExe();
  const commit = bin && vscodeCliCommit(bin);
  if (!commit) return null;
  const productFile = path.join(VSCODE_CLI_DATA_DIR, "serve-web", commit, "product.json");
  try {
    serveWebProductConfiguration = JSON.parse(fs.readFileSync(productFile, "utf8"));
    return serveWebProductConfiguration;
  } catch {
    return null;
  }
}

function getRequestHeader(req, name) {
  const value = req.headers && req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function getWorkbenchAuthority(req) {
  const host =
    getRequestHeader(req, "x-original-host") ||
    getRequestHeader(req, "x-forwarded-host") ||
    getRequestHeader(req, "host") ||
    "";
  return String(host).split(",")[0].trim().replace(/^https?:\/\//i, "").split("/")[0];
}

function workbenchWebConfiguration(req, connectionToken) {
  const productConfiguration = loadServeWebProductConfiguration();
  const remoteAuthority = getWorkbenchAuthority(req);
  if (!productConfiguration || !remoteAuthority) return null;
  return {
    remoteAuthority,
    serverBasePath: "/ide",
    connectionToken: connectionToken || readServeWebToken(),
    enableWorkspaceTrust: false,
    productConfiguration,
    callbackRoute: "/ide/callback",
  };
}

function escapeHtmlAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function injectWorkbenchWebConfiguration(body, req, connectionToken) {
  const configuration = workbenchWebConfiguration(req, connectionToken || readServeWebToken());
  if (!configuration) return body;
  const settings = escapeHtmlAttribute(JSON.stringify(configuration));
  const meta = `<meta id="vscode-workbench-web-configuration" data-settings='${settings}'>`;
  return body.replace(/(<head\b[^>]*>)/i, `$1\n\t${meta}`);
}

// ── HTTP reverse proxy for /ide/* → code-server ───────────────────────────

function proxyRequest(req, res, basePath, connectionToken = "") {
  if (!codeServerProc || !codeServerPort) {
    if (!tryAdoptExistingServeWeb()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "code-server not running" }));
      return;
    }
  }
  if (!connectionToken) connectionToken = readServeWebToken();

  // Strip /ide prefix and forward to code-server
  let targetPath = req.url;
  if (basePath && targetPath.startsWith(basePath) && !serveWebBasePathMode) {
    targetPath = targetPath.slice(basePath.length) || "/";
  }

  const accept = String(req.headers.accept || "").toLowerCase();
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const isWorkbenchDocument =
    req.method === "GET" &&
    (pathname === "/ide" || pathname === "/ide/") &&
    accept.includes("text/html");
  const options = {
    hostname: "127.0.0.1",
    port: codeServerPort,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${codeServerPort}`,
    },
  };
  if (isWorkbenchDocument) delete options.headers["accept-encoding"];

  const proxyReq = http.request(options, (proxyRes) => {
    const agentSetCookie = res.getHeader("Set-Cookie");
    const mergeResponseHeaders = (source) => {
      const headers = { ...source };
      if (agentSetCookie) {
        const upstreamSetCookie = headers["set-cookie"];
        const toArray = (value) => Array.isArray(value) ? value : value ? [value] : [];
        headers["set-cookie"] = [...toArray(agentSetCookie), ...toArray(upstreamSetCookie)];
      }
      return headers;
    };
    if (!isWorkbenchDocument || proxyRes.headers["content-encoding"]) {
      res.writeHead(proxyRes.statusCode, mergeResponseHeaders(proxyRes.headers));
      proxyRes.pipe(res, { end: true });
      return;
    }

    const chunks = [];
    proxyRes.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `proxy error: ${e.message}` }));
      } else {
        res.destroy(e);
      }
    });
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const source = Buffer.concat(chunks).toString("utf8");
      const body = injectWorkbenchWebConfiguration(source, req, connectionToken);
      const headers = mergeResponseHeaders(proxyRes.headers);
      delete headers["transfer-encoding"];
      headers["content-length"] = Buffer.byteLength(body);
      res.writeHead(proxyRes.statusCode, headers);
      res.end(body);
    });
  });

  proxyReq.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `proxy error: ${e.message}` }));
  });

  req.pipe(proxyReq, { end: true });
}

// ── WebSocket proxy for code-server ───────────────────────────────────────

function proxyWebSocket(req, socket, head) {
  if (!codeServerProc || !codeServerPort) {
    if (!tryAdoptExistingServeWeb()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  const net = require("net");
  const target = net.createConnection({ host: "127.0.0.1", port: codeServerPort }, () => {
    // Forward the upgrade to serve-web, but rewrite Host/Origin to the loopback
    // target. VS Code's serve-web validates the WebSocket Host/Origin against
    // its own bind address; if we forward the public tunnel domain verbatim it
    // rejects the socket and the workbench reports "WebSocket close 1006".
    const localHost = `127.0.0.1:${codeServerPort}`;
    const headers = { ...req.headers };
    headers.host = localHost;
    if (headers.origin) headers.origin = `http://${localHost}`;
    const reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const headerStr = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    try { target.setNoDelay(true); } catch {}
    try { socket.setNoDelay(true); } catch {}
    target.write(reqLine + headerStr + "\r\n\r\n");
    if (head && head.length) target.write(head);
  });

  target.on("data", (data) => { try { socket.write(data); } catch {} });
  socket.on("data", (data) => { try { target.write(data); } catch {} });
  target.on("error", () => socket.destroy());
  target.on("close", () => socket.destroy());
  socket.on("error", () => target.destroy());
  socket.on("close", () => target.destroy());
}

// ── Helper ────────────────────────────────────────────────────────────────

module.exports = {
  start,
  startServeWeb,
  stop,
  healthCheck,
  getPort,
  getPassword,
  isRunning,
  proxyRequest,
  proxyWebSocket,
  findCodeServer,
  findVscodeCliExe,
  ensureVscodeCli,
  ensureServeWebServer,
  installCodeServer,
};

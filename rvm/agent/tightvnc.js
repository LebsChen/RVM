"use strict";
// dev-agent · tightvnc — Portable TightVNC bootstrap for Windows
// Downloads a private cache under ~/.rvm/tightvnc/ and launches
// tvnserver.exe in application mode with per-user HKCU settings.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { runShell } = require("./core.js");

const isWin = process.platform === "win32";
const CACHE_DIR = path.join(os.homedir(), ".rvm", "tightvnc");
const PORT = 5901;
const RELEASE_BASE = "https://github.com/chenall/tightvnc/releases/download/v2.8.88";

let tightVncProc = null;

function cacheRoot() {
  return CACHE_DIR;
}

function archAsset() {
  return process.arch === "ia32" ? "Release_x86_Bin.zip" : "Release_x64_Bin.zip";
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

function probeTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("close", () => {
      if (!done) finish(false);
    });
  });
}

function waitForTcp(host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await probeTcp(host, port)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  })();
}

function killStalePortableTightVnc(log) {
  if (!isWin) return false;
  const root = CACHE_DIR.replace(/'/g, "''");
  const ps = [
    "$root = '" + root + "'",
    "$pids = @(Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -ieq 'tvnserver.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root)",
    "} | Select-Object -ExpandProperty ProcessId)",
    "if ($pids.Count -gt 0) { $pids | ForEach-Object { Stop-Process -Id $_ -Force }; Write-Output $pids.Count }",
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    stdio: "pipe",
  });
  const killed = r.status === 0 && !!String(r.stdout || "").trim();
  if (killed) {
    log("[tightvnc] Killed stale portable TightVNC instances");
  }
  return killed;
}

async function downloadWithMirror(log, directUrl, retryUrl, run) {
  let r = await run(directUrl);
  if (r.exit_code === 0) {
    log("[tightvnc] Downloaded via direct URL");
    return true;
  }
  // No mirror (e.g. GITHUB_MIRROR explicitly cleared) — don't retry.
  if (!retryUrl || retryUrl === directUrl) {
    log(`[tightvnc] Download failed: ${r.stderr || r.stdout}`);
    return false;
  }
  log(`[tightvnc] Direct download failed, retrying via mirror: ${r.stderr || r.stdout}`);
  r = await run(retryUrl);
  if (r.exit_code === 0) {
    log("[tightvnc] Downloaded via mirror");
    return true;
  }
  log(`[tightvnc] Mirror download failed: ${r.stderr || r.stdout}`);
  return false;
}

async function ensurePortableTightVnc(log) {
  if (!isWin) return null;

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const exe = findFile(CACHE_DIR, "tvnserver.exe");
  if (exe) return exe;

  const zip = archAsset();
  const url = `${RELEASE_BASE}/${zip}`;
  // Mirror comes from GITHUB_MIRROR (defaults to gh-proxy). If the user cleared
  // it, ghMirror returns the URL unchanged and we download directly only.
  let mirrorUrl = null;
  try {
    const m = require("./gh-mirror.js").ghMirror(url);
    if (m && m !== url) mirrorUrl = m;
  } catch {}
  const archive = path.join(CACHE_DIR, zip);
  log(`[tightvnc] Downloading portable TightVNC ${zip}...`);
  const run = (downloadUrl) => runShell(
    `Invoke-WebRequest -Uri "${downloadUrl}" -OutFile "${archive}"; Expand-Archive -Path "${archive}" -DestinationPath "${CACHE_DIR}" -Force`,
    undefined,
    300000,
  );
  if (!(await downloadWithMirror(log, url, mirrorUrl, run))) return null;

  return findFile(CACHE_DIR, "tvnserver.exe");
}

async function configureRegistry(log) {
  const base = "HKCU\\Software\\TightVNC\\Server";
  const reg64 = process.arch === "ia32" ? "" : " /reg:64";
  const sets = [
    ["AcceptRfbConnections", "1"],
    ["RfbPort", String(PORT)],
    ["AllowLoopback", "1"],
    ["LoopbackOnly", "1"],
    ["UseVncAuthentication", "0"],
    ["UseControlAuthentication", "0"],
    ["AlwaysShared", "1"],
  ];
  for (const [key, value] of sets) {
    const r = await runShell(
      `reg add "${base}" /v ${key} /t REG_DWORD /d ${value} /f${reg64}`,
      undefined,
      10000,
    );
    if (r.exit_code !== 0) {
      log(`[tightvnc] Registry update failed for ${key}: ${r.stderr || r.stdout}`);
      return false;
    }
  }
  return true;
}

async function startPortableTightVnc(log) {
  if (!isWin) return { ok: false };

  try {
    const listening = await probeTcp("127.0.0.1", PORT);
    if (listening) {
      log(`[tightvnc] Reusing existing portable TightVNC on 127.0.0.1:${PORT}`);
      return {
        ok: true,
        host: "127.0.0.1",
        port: PORT,
        auth: "none",
        cleanup() {},
      };
    }

    await killStalePortableTightVnc(log);

    const exe = await ensurePortableTightVnc(log);
    if (!exe) return { ok: false };

    const configured = await configureRegistry(log);
    if (!configured) return { ok: false };

    const proc = spawn(exe, ["-run"], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    proc.unref();
    tightVncProc = proc;

    const ok = await waitForTcp("127.0.0.1", PORT, 15000);
    if (!ok) {
      try { proc.kill(); } catch {}
      tightVncProc = null;
      log("[tightvnc] tvnserver.exe did not listen on 127.0.0.1:5901");
      return { ok: false };
    }

    log(`[tightvnc] Portable TightVNC ready on 127.0.0.1:${PORT}`);
    return {
      ok: true,
      host: "127.0.0.1",
      port: PORT,
      auth: "none",
      proc,
      cleanup() {
        if (tightVncProc) {
          try { tightVncProc.kill(); } catch {}
          tightVncProc = null;
          log("[tightvnc] Stopped portable TightVNC");
        }
      },
    };
  } catch (e) {
    log(`[tightvnc] Startup failed: ${e.message || e}`);
    try { if (tightVncProc) tightVncProc.kill(); } catch {}
    tightVncProc = null;
    return { ok: false };
  }
}

function stopPortableTightVnc(log) {
  const hadProc = !!tightVncProc;
  if (tightVncProc) {
    try { tightVncProc.kill(); } catch {}
    tightVncProc = null;
  }
  let killed = false;
  try { killed = killStalePortableTightVnc(log || (() => {})); } catch {}
  if (log && (hadProc || killed)) log("[tightvnc] Stopped portable TightVNC");
}

// Path to the RVM-downloaded single-file/portable TightVNC (tvnserver.exe),
// or null if it hasn't been fetched into the RVM cache yet.
function findCached() {
  try { return findFile(CACHE_DIR, "tvnserver.exe"); } catch { return null; }
}

module.exports = {
  startPortableTightVnc,
  stopPortableTightVnc,
  ensurePortableTightVnc,
  cacheRoot,
  findCached,
  PORT,
};

"use strict";
// dev-agent · tunnel — Cloudflare quick tunnel management (zero-config)
// Auto-detects/downloads cloudflared, starts quick tunnel, extracts public URL.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const TRY_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function which(cmd) {
  try {
    const r = execSync(isWin ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return r.trim().split("\n")[0].trim();
  } catch {
    return null;
  }
}

// Run a command without blocking the event loop (unlike execSync). Resolves
// with the exit code, or -1 on spawn error / timeout. windowsHide keeps any
// console window from popping up on Windows.
function runAsync(cmd, args, timeout, useShell) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve(code); } };
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, stdio: "ignore", shell: !!useShell });
    } catch {
      return finish(-1);
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} finish(-1); }, timeout);
    proc.on("error", () => { clearTimeout(timer); finish(-1); });
    proc.on("exit", (code) => { clearTimeout(timer); finish(code == null ? -1 : code); });
  });
}

async function downloadCloudflared(log) {
  const dest = path.join(os.homedir(), ".cloud-dev", isWin ? "cloudflared.exe" : "cloudflared");
  if (fs.existsSync(dest)) {
    // Verify it works (async so it never freezes the event loop)
    const ok = (await runAsync(dest, ["--version"], 5000)) === 0;
    if (ok) return dest;
    log("[tunnel] Existing cloudflared broken, re-downloading...");
  }

  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const arch = os.arch();
  let url;
  if (isWin) {
    url = arch === "arm64"
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-arm64.exe"
      : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
  } else if (isMac) {
    url = arch === "arm64"
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
      : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz";
  } else {
    url = arch === "arm64"
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
      : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  }

  // Prefer the (default gh-proxy) GitHub accelerator, fall back to the direct
  // GitHub URL if the mirror fails — so a down/blocked mirror never breaks the
  // download entirely.
  let mirrored = url;
  try { mirrored = require("./gh-mirror.js").ghMirror(url); } catch {}
  const candidates = mirrored && mirrored !== url ? [mirrored, url] : [url];

  const tryDownload = async (u) => {
    if (isMac) {
      const tgz = dest + ".tgz";
      return runAsync(
        "/bin/sh",
        ["-c", `curl -fsSL -o "${tgz}" "${u}" && tar xzf "${tgz}" -C "${dir}" && rm -f "${tgz}"`],
        120000,
      );
    }
    return runAsync("curl", ["-fsSL", "-o", dest, u], 120000);
  };

  let code = 1;
  for (const u of candidates) {
    log(`[tunnel] Downloading cloudflared from ${u}...`);
    code = await tryDownload(u);
    if (code === 0) break;
    log(`[tunnel] Download failed (exit ${code})${u === candidates[candidates.length - 1] ? "" : ", trying next source..."}`);
  }
  if (code !== 0) {
    return null;
  }
  try { if (!isWin) fs.chmodSync(dest, 0o755); } catch {}
  log("[tunnel] cloudflared downloaded successfully");
  return dest;
}

async function findCloudflared(log, allowDownload = true) {
  // Check PATH first
  const inPath = which("cloudflared");
  if (inPath) return inPath;

  // Check custom env var
  if (process.env.CLOUDFLARED && fs.existsSync(process.env.CLOUDFLARED))
    return process.env.CLOUDFLARED;

  // Check ~/.cloud-dev/
  const local = path.join(os.homedir(), ".cloud-dev", isWin ? "cloudflared.exe" : "cloudflared");
  if (fs.existsSync(local)) {
    try { if (!isWin) fs.chmodSync(local, 0o755); } catch {}
    return local;
  }

  if (!allowDownload) {
    log("[tunnel] cloudflared not present and auto-install disabled for this service.");
    return null;
  }

  // Try to download (async — never blocks startup)
  return await downloadCloudflared(log);
}

function startQuickTunnel(cfPath, localPort, log, onUrl) {
  let proc = null;
  let stopped = false;
  let currentUrl = "";
  let pendingUrl = "";
  let connected = false;

  const emitUrl = (url) => {
    if (!url || url === currentUrl) return;
    currentUrl = url;
    log(`[tunnel] Public URL: ${currentUrl}`);
    onUrl(currentUrl);
  };

  const clearUrl = () => {
    pendingUrl = "";
    connected = false;
    if (currentUrl) {
      currentUrl = "";
      onUrl("");
    }
  };

  const doSpawn = () => {
    if (stopped) return;
    // Default to http2 — QUIC (UDP/7844) is blocked on many cloud VMs (Devin,
    // AWS, GCP, etc.) causing 530 errors. http2 works everywhere and still
    // supports WebSocket upgrade for VNC/PTY/CDP. Override via TUNNEL_PROTOCOL
    // env var (e.g. "quic") if you know UDP is allowed.
    const args = ["tunnel", "--no-autoupdate"];
    const proto = (process.env.TUNNEL_PROTOCOL || "http2").trim();
    args.push("--protocol", proto);
    args.push("--url", `http://127.0.0.1:${localPort}`);
    log(`[tunnel] Starting: ${cfPath} ${args.join(" ")}`);

    try {
      proc = spawn(cfPath, args, { windowsHide: true, stdio: "pipe" });
    } catch (e) {
      log("[tunnel] Spawn failed: " + (e.message || e));
      setTimeout(doSpawn, 5000);
      return;
    }

    const onData = (buf) => {
      const text = buf.toString();
      // Log all cloudflared output for diagnostics
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) log(`[tunnel] ${t}`);
        const urlMatch = t.match(TRY_RE);
        if (urlMatch) {
          pendingUrl = urlMatch[0];
          if (connected) emitUrl(pendingUrl);
        }
        if (/Registered tunnel connection/i.test(t)) {
          connected = true;
          if (pendingUrl) emitUrl(pendingUrl);
        }
      }
    };

    if (proc.stdout) proc.stdout.on("data", onData);
    if (proc.stderr) proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      log(`[tunnel] Process error: ${err.message}`);
    });
    proc.on("exit", (code) => {
      log(`[tunnel] cloudflared exited with code ${code}`);
      clearUrl();
      if (!stopped) {
        log(`[tunnel] Reconnecting in 5s...`);
        setTimeout(doSpawn, 5000);
      }
    });
  };

  doSpawn();

  return {
    stop() { stopped = true; try { proc && proc.kill(); } catch {} },
    currentUrl: () => currentUrl,
  };
}

// Normalize a user-entered fixed domain into a clean origin URL
// ("dev.example.com" → "https://dev.example.com", strips any path/trailing /).
function normalizePublicUrl(s) {
  s = (s || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    return new URL(s).origin;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

// Named (token) tunnel: a stable, user-owned Cloudflare tunnel whose public
// hostname never changes across restarts. The public hostname → service
// (http://localhost:<port>) mapping is configured in the Cloudflare Zero Trust
// dashboard for the tunnel the token belongs to, so we cannot parse the URL
// from cloudflared output — we surface the fixed domain the user configured.
function startNamedTunnel(cfPath, token, publicUrl, log, onUrl) {
  let proc = null;
  let stopped = false;
  let currentUrl = "";

  const emitUrl = (url) => {
    if (!url || url === currentUrl) return;
    currentUrl = url;
    log(`[tunnel] Public URL: ${currentUrl}`);
    onUrl(currentUrl);
  };

  const doSpawn = () => {
    if (stopped) return;
    const proto = (process.env.TUNNEL_PROTOCOL || "http2").trim();
    const args = ["tunnel", "--no-autoupdate", "run"];
    if (proto) args.push("--protocol", proto);
    args.push("--token", token);
    log(`[tunnel] Starting named tunnel: ${cfPath} tunnel --no-autoupdate run${proto ? " --protocol " + proto : ""} --token ***`);

    try {
      proc = spawn(cfPath, args, { windowsHide: true, stdio: "pipe" });
    } catch (e) {
      log("[tunnel] Spawn failed: " + (e.message || e));
      setTimeout(doSpawn, 5000);
      return;
    }

    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (t) log(`[tunnel] ${t}`);
        // A named tunnel is live once at least one edge connection registers.
        if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(t)) {
          if (publicUrl) emitUrl(publicUrl);
        }
      }
    };

    if (proc.stdout) proc.stdout.on("data", onData);
    if (proc.stderr) proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      log(`[tunnel] Process error: ${err.message}`);
    });
    proc.on("exit", (code) => {
      log(`[tunnel] cloudflared exited with code ${code}`);
      if (currentUrl) {
        currentUrl = "";
        onUrl("");
      }
      if (!stopped) {
        log(`[tunnel] Reconnecting in 5s...`);
        setTimeout(doSpawn, 5000);
      }
    });
  };

  doSpawn();

  return {
    stop() { stopped = true; try { proc && proc.kill(); } catch {} },
    currentUrl: () => currentUrl,
  };
}

async function setupTunnel(localPort, log, onUrl, allowDownload = true) {
  const cfPath = await findCloudflared(log, allowDownload);
  if (!cfPath) {
    log("[tunnel] cloudflared not available. Tunnel disabled — use direct IP.");
    return { stop() {}, currentUrl: () => "" };
  }
  const token = (process.env.CF_TUNNEL_TOKEN || "").trim();
  if (token) {
    const publicUrl = normalizePublicUrl(process.env.TUNNEL_PUBLIC_URL || "");
    log(
      `[tunnel] Named tunnel mode (token provided)` +
        (publicUrl
          ? `, fixed public URL ${publicUrl}`
          : ` — no fixed domain set; configure the tunnel's public hostname → http://localhost:${localPort} in the Cloudflare dashboard`)
    );
    return startNamedTunnel(cfPath, token, publicUrl, log, onUrl);
  }
  return startQuickTunnel(cfPath, localPort, log, onUrl);
}

module.exports = { setupTunnel, findCloudflared, downloadCloudflared };

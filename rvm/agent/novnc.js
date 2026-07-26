"use strict";
// noVNC integration — serves noVNC web client + websockify bridge
// Cloud-Dev accesses VNC desktop via:
//   - /vnc-ws (raw WebSocket VNC, used by Cloud-Dev's built-in noVNC viewer)
//   - /novnc/ (full noVNC web client, standalone browser access)
//   - /api/vnc/* (VNC management API)
//
// This module:
//  1. Downloads noVNC if not present (or uses bundled copy)
//  2. Serves the noVNC static files at /novnc/
//  3. Manages websockify for WebSocket-to-VNC bridging
//  4. Sets up Xvfb + x11vnc (Linux) or built-in VNC (Windows) if needed

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { runShell } = require("./core.js");

const isWin = process.platform === "win32";
const NOVNC_DIR = path.join(os.homedir(), ".rvm", "novnc");

let xvfbProc = null;
let x11vncProc = null;
let websockifyProc = null;

// ── noVNC static file serving ─────────────────────────────────────────────

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

function serveNoVncFile(req, res) {
  let urlPath = req.url.replace(/\?.*$/, ""); // strip query
  if (urlPath.startsWith("/novnc")) urlPath = urlPath.slice(6);
  if (!urlPath || urlPath === "/") urlPath = "/vnc.html";

  const filePath = path.join(NOVNC_DIR, urlPath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(NOVNC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message || e));
  }
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

// ── Download noVNC ────────────────────────────────────────────────────────

async function downloadWithMirror(log, directUrl, retryUrl, run) {
  let r = await run(directUrl);
  if (r.exit_code === 0) {
    log(`[novnc] Downloaded via direct URL`);
    return true;
  }
  // No mirror (e.g. GITHUB_MIRROR explicitly cleared) — don't retry.
  if (!retryUrl || retryUrl === directUrl) {
    log(`[novnc] Download failed: ${r.stderr || r.stdout}`);
    return false;
  }
  log(`[novnc] Direct download failed, retrying via mirror: ${r.stderr || r.stdout}`);
  r = await run(retryUrl);
  if (r.exit_code === 0) {
    log(`[novnc] Downloaded via mirror`);
    return true;
  }
  log(`[novnc] Mirror download failed: ${r.stderr || r.stdout}`);
  return false;
}

async function ensureNoVnc(log) {
  if (fs.existsSync(path.join(NOVNC_DIR, "vnc.html"))) {
    log("[novnc] Using existing noVNC at " + NOVNC_DIR);
    return true;
  }

  log("[novnc] Downloading noVNC...");
  const version = "1.5.0";
  const url = `https://github.com/novnc/noVNC/archive/refs/tags/v${version}.tar.gz`;
  // Mirror comes from GITHUB_MIRROR (defaults to gh-proxy). If the user cleared
  // it, ghMirror returns the URL unchanged and we download directly only.
  let mirrorUrl = null;
  try {
    const m = require("./gh-mirror.js").ghMirror(url);
    if (m && m !== url) mirrorUrl = m;
  } catch {}

  if (!fs.existsSync(NOVNC_DIR)) fs.mkdirSync(NOVNC_DIR, { recursive: true });

  if (isWin) {
    const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
    const tarball = path.join(tempDir, "novnc.tar.gz");
    const run = (downloadUrl) => runShell(
      `Invoke-WebRequest -Uri "${downloadUrl}" -OutFile "${tarball}"; ` +
      `tar -xzf "${tarball}" -C "${NOVNC_DIR}" --strip-components=1`,
      undefined, 60000
    );
    if (!(await downloadWithMirror(log, url, mirrorUrl, run))) return false;
  } else {
    const run = (downloadUrl) => runShell(
      `curl -fsSL '${downloadUrl}' | tar -xz -C '${NOVNC_DIR}' --strip-components=1`,
      undefined, 60000
    );
    if (!(await downloadWithMirror(log, url, mirrorUrl, run))) return false;
  }

  log("[novnc] Downloaded successfully");
  return true;
}

// ── VNC server setup (Linux: Xvfb + x11vnc) ──────────────────────────────

async function setupVncServer(vncPort, vncPassword, log) {
  if (isWin) {
    // Windows: check if a VNC server is already running (e.g. TightVNC, UltraVNC)
    const r = await runShell(
      `Test-NetConnection -ComputerName 127.0.0.1 -Port ${vncPort} -InformationLevel Quiet`,
      undefined, 5000
    );
    if (r.stdout.trim() === "True") {
      log(`[vnc] VNC server already running on port ${vncPort}`);
      return { type: "existing", port: vncPort, host: getLocalIp() };
    }
    log("[vnc] No VNC server found on Windows. Install TightVNC or TigerVNC for desktop sharing.");
    return { type: "none", port: vncPort, host: "127.0.0.1" };
  }

  // Linux: Check if Xvfb and x11vnc are available, set them up
  const display = process.env.DISPLAY || ":99";
  const displayNum = display.replace(":", "");

  // Check if display already exists
  const displayCheck = await runShell(`xdpyinfo -display ${display} >/dev/null 2>&1 && echo yes || echo no`, undefined, 5000);
  const hasDisplay = displayCheck.stdout.trim() === "yes";

  if (!hasDisplay) {
    // Start Xvfb
    const xvfbCheck = await runShell("which Xvfb", undefined, 3000);
    if (xvfbCheck.exit_code !== 0) {
      log("[vnc] Xvfb not found. Install with: sudo apt-get install xvfb");
      // Try to install
      await runShell("sudo apt-get update -qq && sudo apt-get install -y -qq xvfb x11vnc 2>/dev/null", undefined, 60000);
    }

    const xvfbCheck2 = await runShell("which Xvfb", undefined, 3000);
    if (xvfbCheck2.exit_code !== 0) {
      log("[vnc] Xvfb still not available. Cannot start virtual display.");
    } else {
      log(`[vnc] Starting Xvfb on display ${display}`);
      xvfbProc = spawn("Xvfb", [display, "-screen", "0", "1920x1080x24", "-ac"], {
        stdio: "ignore",
        env: { ...process.env },
      });
      xvfbProc.on("error", (err) => { log(`[vnc] Xvfb error: ${err.message}`); xvfbProc = null; });
      xvfbProc.on("exit", (code) => { log(`[vnc] Xvfb exited: ${code}`); xvfbProc = null; });

      await new Promise((r) => setTimeout(r, 1000));
      process.env.DISPLAY = display;
    }
  }

  // Check if x11vnc is running
  const vncCheck = await runShell(`ss -tlnp 2>/dev/null | grep ':${vncPort}' || true`, undefined, 3000);
  if (vncCheck.stdout.includes(`:${vncPort}`)) {
    log(`[vnc] VNC already running on port ${vncPort}`);
    return { type: "existing", port: vncPort, proc: null, xvfb: xvfbProc };
  }

  // Start x11vnc
  const x11vncCheck = await runShell("which x11vnc", undefined, 3000);
  if (x11vncCheck.exit_code !== 0) {
    log("[vnc] x11vnc not found. Install with: sudo apt-get install x11vnc");
    await runShell("sudo apt-get install -y -qq x11vnc 2>/dev/null", undefined, 60000);
  }

  const x11vncCheck2 = await runShell("which x11vnc", undefined, 3000);
  if (x11vncCheck2.exit_code !== 0) {
    log("[vnc] x11vnc still not available. Skipping x11vnc startup.");
    return { type: "none", port: vncPort, host: "127.0.0.1", xvfb: xvfbProc };
  }

  const passwdFile = path.join(os.homedir(), ".rvm", "vnc-passwd");
  const passwdDir = path.dirname(passwdFile);
  if (!fs.existsSync(passwdDir)) fs.mkdirSync(passwdDir, { recursive: true });
  await runShell(`x11vnc -storepasswd '${vncPassword}' '${passwdFile}' 2>/dev/null`, undefined, 5000);

  log(`[vnc] Starting x11vnc on display ${display}, port ${vncPort}`);
  x11vncProc = spawn("x11vnc", [
    "-display", display,
    "-rfbport", String(vncPort),
    "-rfbauth", passwdFile,
    "-forever", "-shared", "-noxdamage",
    "-threads",
  ], { stdio: "ignore", env: { ...process.env, DISPLAY: display } });

  x11vncProc.on("error", (err) => { log(`[vnc] x11vnc error: ${err.message}`); x11vncProc = null; });
  x11vncProc.on("exit", (code) => { log(`[vnc] x11vnc exited: ${code}`); x11vncProc = null; });

  await new Promise((r) => setTimeout(r, 1000));
  return { type: "x11vnc", port: vncPort, host: "127.0.0.1", proc: x11vncProc, xvfb: xvfbProc };
}

// ── websockify bridge ─────────────────────────────────────────────────────
// Alternative to core.js's built-in WebSocket VNC proxy.
// Uses python websockify for maximum compatibility.

async function startWebsockify(listenPort, vncPort, log) {
  // Check if websockify is available
  const wsCheck = await runShell("which websockify 2>/dev/null || pip3 show websockify 2>/dev/null", undefined, 5000);
  if (wsCheck.exit_code !== 0) {
    log("[websockify] Not found, installing via pip...");
    await runShell("pip3 install websockify 2>/dev/null || pip install websockify 2>/dev/null", undefined, 60000);
  }

  const wsPath = isWin
    ? "python -m websockify"
    : "websockify";

  log(`[websockify] Starting: ${listenPort} -> localhost:${vncPort}`);
  const web = path.join(NOVNC_DIR);

  websockifyProc = spawn("websockify", [
    "--web", web,
    String(listenPort),
    `localhost:${vncPort}`,
  ], { stdio: "ignore" });

  websockifyProc.on("exit", (code) => {
    log(`[websockify] exited: ${code}`);
    websockifyProc = null;
  });

  return websockifyProc;
}

// ── Management API ────────────────────────────────────────────────────────

async function handleApiRoute(route, method, body, log) {
  const sub = route.replace("/api/vnc/", "");

  switch (sub) {
    case "status":
      return {
        status: 200,
        body: {
          vnc_running: !!x11vncProc || isWin,
          xvfb_running: !!xvfbProc,
          websockify_running: !!websockifyProc,
          novnc_available: fs.existsSync(path.join(NOVNC_DIR, "vnc.html")),
          display: process.env.DISPLAY || ":0",
        },
      };

    case "start": {
      const vncPort = body.port || 5900;
      const password = body.password || "devin";
      const result = await setupVncServer(vncPort, password, log);
      return { status: 200, body: { ok: true, ...result } };
    }

    case "stop":
      if (x11vncProc) { try { x11vncProc.kill(); } catch {} x11vncProc = null; }
      if (xvfbProc) { try { xvfbProc.kill(); } catch {} xvfbProc = null; }
      if (websockifyProc) { try { websockifyProc.kill(); } catch {} websockifyProc = null; }
      return { status: 200, body: { ok: true } };

    default:
      return { status: 404, body: { error: `unknown vnc route: ${sub}` } };
  }
}

function cleanup() {
  if (x11vncProc) try { x11vncProc.kill(); } catch {}
  if (xvfbProc) try { xvfbProc.kill(); } catch {}
  if (websockifyProc) try { websockifyProc.kill(); } catch {}
}

module.exports = {
  serveNoVncFile,
  ensureNoVnc,
  setupVncServer,
  startWebsockify,
  handleApiRoute,
  cleanup,
};

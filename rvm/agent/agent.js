#!/usr/bin/env node
"use strict";
// RVM Agent — Full devin-remote compatible server
// Covers ALL official devin-remote capabilities:
//   Core:     exec, file I/O, edit, multi-edit, glob, grep, search, computer use
//   PTY:      interactive pseudo-terminal via WebSocket
//   VNC:      desktop streaming via WebSocket proxy
//   CDP:      Chrome DevTools Protocol proxy
//   Git:      clone, pull, push, status, diff, checkout, log
//   Storage:  upload, download, binary file transfer, scratchpad
//   MCP:      Streamable HTTP MCP endpoint (/mcp)
//   Tunnel:   cloudflare quick tunnel + named tunnel
//   Deploy:   ZIP project upload/deployment
//   Ports:    expose local ports via tunnel
//   Middleware: pre/post tool hooks, session lifecycle
//   Events:   subscribe to remote events
//   Recording: screen recording start/stop
//   Notebook:  Jupyter .ipynb reading
//   OIDC:     identity token generation
//   Code scan: pattern matching
//   Repo setup: clone + install deps + build
//
// Usage:
//   node agent.js
//   TOKEN=xxx PORT=9876 node agent.js

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const core = require("./core.js");
const git = require("./git.js");
const worklog = require("./worklog.js");
const storage = require("./storage.js");
const mcp = require("./mcp.js");
const repoSetup = require("./repo-setup.js");
const middleware = require("./middleware.js");
const codeScan = require("./code-scan.js");
const deploy = require("./deploy.js");
const exposePort = require("./expose-port.js");
const recording = require("./recording.js");
const notebook = require("./notebook.js");
const codeServer = require("./code-server.js");
const installer = require("./installer.js");
const novnc = require("./novnc.js");
const { setupVnc } = require("./vnc-setup.js");
const { setupTunnel } = require("./tunnel.js");

const CONN_DIR = process.env.CONN_DIR || __dirname;
const CONN_FILE = path.join(CONN_DIR, "conn.json");

function loadConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONN_FILE, "utf8")); } catch {}
  return {
    token: process.env.TOKEN || c.token || crypto.randomBytes(24).toString("hex"),
    port: Number(process.env.PORT || c.port || 9876),
    vncPort: Number(process.env.VNC_PORT || c.vncPort || 5900),
    vncPassword: process.env.VNC_PASSWORD || c.vncPassword || "devin",
    // Default the workspace to the whole computer (filesystem root) so the
    // Web IDE and file APIs have full-machine access; overridable via ROOT.
    root: process.env.ROOT || c.root || ((process.platform === "win32" ? (process.env.SystemDrive || "C:") + "\\" : "/")),
    tunnel: process.env.TUNNEL || c.tunnel || "auto",
    bind: process.env.BIND || c.bind || "0.0.0.0",
    cloudflared: process.env.CLOUDFLARED || c.cloudflared || "",
    // Which downloadable services may be auto-installed when missing. Selected
    // in the desktop app's "Server" tab; passed via AUTO_INSTALL as a comma
    // list. Unset => all allowed (backward compatible).
    autoInstall: parseAutoInstall(process.env.AUTO_INSTALL),
  };
}

// Returns a Set of service ids allowed to auto-install, or null meaning "all".
function parseAutoInstall(raw) {
  if (raw === undefined || raw === null) return null;
  return new Set(String(raw).split(",").map((s) => s.trim()).filter(Boolean));
}

function canInstall(conf, id) {
  return conf.autoInstall === null || conf.autoInstall.has(id);
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function hasCommand(name) {
  try {
    const cmd = process.platform === "win32" ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 4000, windowsHide: true });
    return !!out.trim();
  } catch {
    return false;
  }
}

function buildCapabilityStatus(vnc) {
  const browserBinary = core.findChromeBinary && core.findChromeBinary();
  const status = {
    exec: "ok",
    file_io: "ok",
    edit: "ok",
    multi_edit: "ok",
    glob: "ok",
    grep: "ok",
    search: "ok",
    ls: "ok",
    upload: "ok",
    download: "ok",
    git: "ok",
    mcp: "ok",
    deploy: "ok",
    scratchpad: "ok",
    events: "ok",
    middleware: "ok",
    port_forwarding: "ok",
    code_scanning: "ok",
    repo_setup: "ok",
    notebook: "ok",
    computer_use: (process.platform === "win32" || hasCommand("xdotool")) ? "ok" : "error",
    browser_cdp: browserBinary ? "ok" : "error",
    cdp_browser: browserBinary ? "ok" : "error",
    vnc_desktop: vnc && vnc.type !== "none" ? "ok" : "error",
    novnc_web_client: fs.existsSync(path.join(os.homedir(), ".rvm", "novnc", "vnc.html")) ? "ok" : "error",
    web_ide: codeServer.isRunning() ? "ok" : "error",
    recording: hasCommand("ffmpeg") ? "ok" : "error",
  };
  return status;
}

// Set once the core HTTP server is listening. Before that a crash means the
// agent never came up and exiting is correct; after it, the throw almost always
// comes from an optional background capability (a VNC/tunnel child process
// emitting 'error', a download failing) and must not take the API surface down.
let serverReady = false;

process.on("uncaughtException", (err) => {
  const ts = new Date().toISOString().slice(11, 19);
  const detail = err && (err.stack || err.message) || err;
  if (serverReady) {
    console.error(`[${ts}] WARN: Uncaught exception (non-fatal): ${detail}`);
    return;
  }
  console.error(`[${ts}] FATAL: Uncaught exception: ${detail}`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  // Do NOT exit here. Capabilities (VNC, noVNC, code-server, tunnel) start in
  // independent background tasks; a stray rejection from one must not take down
  // the core HTTP server or the other capabilities. Log and keep running.
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] WARN: Unhandled rejection (non-fatal): ${err && err.stack || err}`);
});

(async () => {
  try {
  const conf = loadConf();
  worklog.configure(CONN_DIR);
  let publicUrl = "";
  let capabilityStatus = {};

  log("=== RVM (Remote Virtual Machines) Agent ===");
  log(`Host: ${os.hostname()} (${process.platform}/${os.arch()})`);
  log(`Workspace: ${conf.root}`);
  log(`Port: ${conf.port}`);
  log("Capabilities: exec, file I/O, edit, multi-edit, glob, grep, search,");
  log("  computer-use, PTY, VNC, CDP browser, Git, MCP, deploy, port-forward,");
  log("  recording, notebook, code-scan, repo-setup, middleware, events");

  // Shared VNC state — populated asynchronously below so the HTTP server's live
  // getters can read it once VNC comes up. The server starts before every heavy
  // capability (VNC, noVNC, code-server, tunnel) so a slow or failing one never
  // blocks the others; each runs in its own background task and downloads never
  // block startup.
  const vnc = { port: conf.vncPort, proc: null, xvfb: null, type: "none", host: null };

  // Extended route handler
  const extendedHandler = buildExtendedHandler(conf);

  // 1. HTTP server FIRST — the core API/PTY/MCP/CDP surface must be reachable
  //    immediately. The /vnc-ws proxy is attached later, once VNC is actually up.
  log("-- Starting HTTP server --");
  const host = {
    workspaceRoot: () => conf.root,
    vncPort: () => vnc.type !== "none" ? vnc.port : null,
    idePort: () => codeServer.isRunning() ? codeServer.getPort() : null,
    log,
    extendedHandler,
    recordRoute,
  };
  const server = await core.startServer(host, {
    port: conf.port,
    token: conf.token,
    bind: conf.bind,
    vncPort: null,
    vncHost: null,
  });
  serverReady = true;

  // Write an initial conn.json snapshot immediately so the GUI clears any
  // stale URL before the capabilities/tunnel come up.
  persist();

  // 2. VNC + noVNC — background. Downloading noVNC assets / a VNC server must
  //    not block the server or other capabilities. Once VNC is live we attach
  //    the /vnc-ws proxy to the already-listening server.
  (async () => {
    log("-- VNC Setup --");
    try {
      const vncResult = await setupVnc({ vncPort: conf.vncPort, vncPassword: conf.vncPassword }, log);
      Object.assign(vnc, vncResult);
    } catch (e) {
      log(`[vnc] Setup failed (non-fatal): ${e.message}`);
    }
    log(`VNC: type=${vnc.type} port=${vnc.port}`);

    log("-- noVNC Setup --");
    if (canInstall(conf, "novnc")) {
      try {
        await novnc.ensureNoVnc(log);
      } catch (e) {
        log(`[novnc] Download failed (non-fatal): ${e.message}`);
      }
    } else {
      log("[novnc] auto-install disabled for this service; skipping asset download.");
    }
    if (vnc.type === "none" && canInstall(conf, "vnc_server")) {
      try {
        log("-- Attempting full VNC server setup --");
        const vncSetup = await novnc.setupVncServer(conf.vncPort, conf.vncPassword, log);
        if (vncSetup.proc) vnc.proc = vncSetup.proc;
        if (vncSetup.xvfb) vnc.xvfb = vncSetup.xvfb;
        if (vncSetup.host) vnc.host = vncSetup.host;
        if (vncSetup.type !== "none") {
          vnc.type = vncSetup.type;
          vnc.port = vncSetup.port;
        }
      } catch (e) {
        log(`[vnc] Full setup failed (non-fatal): ${e.message}`);
      }
    }
    if (vnc.type !== "none") {
      const vncHost = vnc.host || (process.platform === "win32" ? getLocalIp() : "127.0.0.1");
      try {
        core.setupVncProxy(server.server, vnc.port, conf.token, vncHost);
        log(`[vnc] proxy attached -> ${vncHost}:${vnc.port}`);
      } catch (e) {
        log(`[vnc] proxy attach failed (non-fatal): ${e.message}`);
      }
    }
    persist();
  })().catch((e) => log(`[vnc] background task error (non-fatal): ${e && e.message || e}`));

  // 3. code-server (Web VS Code IDE) — background. Its readiness wait can take
  //    tens of seconds and its CLI download runs async; never awaited here.
  log("-- code-server Setup --");
  (async () => {
    try {
      const idePort = conf.port + 1;
      const csResult = await codeServer.start(idePort, conf.vncPassword, conf.root, log, {
        allowDownload: canInstall(conf, "web_ide"),
        connectionToken: conf.token,
      });
      if (csResult.ok) {
        log(`code-server: http://127.0.0.1:${idePort} (proxied at /ide/)`);
      } else {
        log(`code-server: ${csResult.error || "not available"} (will try on first /ide/ access)`);
      }
    } catch (e) {
      log(`code-server: startup failed (non-fatal): ${e.message}`);
    }
    persist();
  })().catch((e) => log(`[code-server] background task error (non-fatal): ${e && e.message || e}`));

  // 4. Tunnel — background. findCloudflared may download the binary; that runs
  //    asynchronously (spawn, not execSync) so it never blocks startup.
  let tunnel = { stop() {}, currentUrl: () => "" };
  if (conf.tunnel !== "off") {
    (async () => {
      log("-- Tunnel Setup --");
      try {
        tunnel = await setupTunnel(server.port, log, (url) => {
          publicUrl = url || "";
          persist();
          if (publicUrl) {
            log("[tunnel] Public connection endpoints:");
            logEndpointDetails();
          }
        }, canInstall(conf, "cloudflared"));
      } catch (e) {
        log(`[tunnel] Setup failed (non-fatal): ${e.message}`);
      }
    })().catch((e) => log(`[tunnel] background task error (non-fatal): ${e && e.message || e}`));
  }

  // 5. Auto-install remaining selected-but-missing services (ffmpeg, browser, git).
  //    cloudflared / noVNC / Web IDE / VNC are handled by their own tasks above;
  //    these have no runtime path, so pre-install them here in the background.
  //    Installs are best-effort and never block; on Windows without winget/choco
  //    git/ffmpeg fall back to portable downloads (see installer.js).
  // Prepend RVM-managed portable bin dirs (Windows git/ffmpeg) to PATH so
  // name-based invocations resolve them even when nothing is on the system PATH.
  function augmentPathWithPortable() {
    try {
      const sep = process.platform === "win32" ? ";" : ":";
      const cur = (process.env.PATH || "").split(sep);
      const lower = cur.map((d) => d.toLowerCase());
      for (const dir of installer.portableBinDirs()) {
        if (dir && !lower.includes(dir.toLowerCase())) {
          process.env.PATH = dir + sep + (process.env.PATH || "");
          lower.push(dir.toLowerCase());
        }
      }
    } catch {}
  }
  augmentPathWithPortable();

  (async () => {
    for (const id of ["ffmpeg", "browser", "git"]) {
      if (!canInstall(conf, id)) continue;
      let st;
      try { st = installer.status()[id]; } catch { st = null; }
      if (st && st.installed) continue;
      log(`[install] ${id} selected and missing — installing in background...`);
      try {
        const ok = await installer.install(id);
        log(`[install] ${id}: ${ok ? "installed" : "not installed (see logs)"}`);
        if (ok) augmentPathWithPortable();
      } catch (e) {
        log(`[install] ${id} failed (non-fatal): ${e && e.message || e}`);
      }
    }
  })().catch((e) => log(`[install] background task error (non-fatal): ${e && e.message || e}`));

  // 7. Persist connection info. Must never throw — it is called from background
  //    capability tasks and a throw there would surface as an unhandled rejection.
  function persist() {
    try {
    capabilityStatus = buildCapabilityStatus(vnc);
    const bases = resolveEndpointBases();
    const info = {
      pid: process.pid,
      token: conf.token,
      port: server.port,
      vncPort: vnc.port,
      idePort: codeServer.isRunning() ? codeServer.getPort() : 0,
      host: os.hostname(),
      platform: process.platform,
      publicUrl,
      directUrl: bases.directHttp,
      version: "1.0.32",
      endpoints: {
        api: `${bases.http}/api/`,
        mcp: `${bases.http}/mcp`,
        vnc_ws: `${bases.ws}/vnc-ws`,
        pty_ws: `${bases.ws}/pty-ws`,
        cdp_ws: `${bases.ws}/cdp-ws`,
        novnc: `${bases.http}/novnc/`,
        ide: `${bases.http}/ide/`,
      },
      capabilityStatus,
      updated: new Date().toISOString(),
    };
    try {
      if (!fs.existsSync(CONN_DIR)) fs.mkdirSync(CONN_DIR, { recursive: true });
      fs.writeFileSync(CONN_FILE, JSON.stringify(info, null, 2));
    } catch {}
    return info;
    } catch (e) {
      try { log(`[persist] failed (non-fatal): ${e && e.message || e}`); } catch {}
      return null;
    }
  }

  function resolveEndpointBases() {
    const directHttp = `http://${getLocalIp()}:${server.port}`;
    const publicHttp = String(publicUrl || "").trim().replace(/\/+$/, "");
    const http = publicHttp || directHttp;
    return {
      directHttp,
      http,
      ws: http.replace(/^http/i, "ws"),
    };
  }

  function logEndpointDetails() {
    const bases = resolveEndpointBases();
    log(`  Direct URL:  ${bases.directHttp}`);
    if (bases.http !== bases.directHttp) log(`  Public URL:  ${bases.http}`);
    log("────────────────────────────────────────────────────────────────");
    log("  Endpoints (all via single port):");
    log(`    API:       ${bases.http}/api/`);
    log(`    MCP:       ${bases.http}/mcp`);
    log(`    VNC WS:    ${bases.ws}/vnc-ws`);
    log(`    PTY WS:    ${bases.ws}/pty-ws`);
    log(`    CDP WS:    ${bases.ws}/cdp-ws`);
    log(`    noVNC:     ${bases.http}/novnc/`);
    log(`    Web IDE:   ${bases.http}/ide/`);
  }

  persist();
  setInterval(persist, 10000);

  log("");
  log("================================================================");
  log("  RVM (Remote Virtual Machines) — Connection Details:");
  log("----------------------------------------------------------------");
  logEndpointDetails();
  log(`  Token:       ${conf.token}`);
  log("----------------------------------------------------------------");
  log("  Waiting for cloudflare tunnel...");
  log("================================================================");

  // Graceful shutdown
  const cleanup = () => {
    log("Shutting down...");
    tunnel.stop();
    codeServer.stop(log);
    novnc.cleanup();
    if (vnc.cleanup) try { vnc.cleanup(); } catch {}
    if (vnc.proc) try { vnc.proc.kill(); } catch {}
    if (vnc.xvfb) try { vnc.xvfb.kill(); } catch {}
    server.close();
    recording.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.resume();
  } catch (err) {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[${ts}] FATAL: Agent startup failed: ${err.stack || err.message || err}`);
    process.exit(1);
  }
})();

function short(value, max = 500) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function routeTitle(route, body) {
  const sub = route.replace(/^\/api\//, "");
  if (sub.startsWith("git/")) {
    const action = sub.slice(4);
    const arg = body?.path || body?.file || body?.ref || body?.branch || body?.name || "";
    return short(`${action}${arg ? ` ${arg}` : ""}`);
  }
  if (sub.startsWith("repo/") || sub.startsWith("deploy/")) {
    const arg = body?.path || body?.url || body?.name || "";
    return short(`${sub}${arg ? ` ${arg}` : ""}`);
  }
  return short(route);
}

async function recordRoute(route, method, body, response) {
  if (route.startsWith("/api/worklog/")) return;
  if (route === "/api/health" || route === "/api/ping" || route === "/api/capabilities" ||
      route === "/api/ls" || route === "/api/read" || route === "/api/screenshot" ||
      route.startsWith("/api/events/")) return;
  const result = response?.body || {};
  if (route === "/api/exec-sync" || route === "/api/exec") {
    const command = short(body?.cmd || body?.command);
    if (!command) return;
    worklog.record("command_exec", "shell", command, {
      exit_code: result.result?.exit_code,
      stdout: short(result.result?.stdout, 1000),
      stderr: short(result.result?.stderr, 1000),
    });
    return;
  }
  if (route === "/api/write" || route === "/api/edit" || route === "/api/multi-edit") {
    worklog.record("file_change", "file", body?.path || body?.file_path || "文件变更", {
      action: route.slice("/api/".length),
      status: response?.status,
    });
    return;
  }
  if (route.startsWith("/api/git/")) {
    worklog.record("git", "git", routeTitle(route, body), { status: response?.status });
    return;
  }
  if (route === "/api/computer-use") {
    worklog.record("computer", "computer", body?.action || "computer use", { status: response?.status });
    return;
  }
  if (route === "/mcp" || route.startsWith("/mcp/")) {
    worklog.record("mcp", "mcp", body?.params?.name || body?.method || "MCP", {
      status: response?.status,
    });
    return;
  }
  if (route === "/api/upload" || route === "/api/download" ||
      route.startsWith("/api/repo/") || route.startsWith("/api/deploy/")) {
    const category = route.startsWith("/api/repo/")
      ? "repo"
      : route.startsWith("/api/deploy/")
        ? "deploy"
        : "file";
    const type = route.startsWith("/api/repo/")
      ? "repo"
      : route.startsWith("/api/deploy/")
        ? "deploy"
        : "file_transfer";
    worklog.record(type, category, routeTitle(route, body), { status: response?.status });
  }
}

function buildExtendedHandler(conf) {
  // Returns an async function that handles extended routes beyond core
  return async function extendedHandler(route, method, headers, body, token) {
    // ── Worklog ──────────────────────────────────────────────
    if (route.startsWith("/api/worklog/")) {
      return worklog.handleRoute(route, method, body);
    }

    // ── Git operations ────────────────────────────────────────
    if (route.startsWith("/api/git/")) {
      return git.handleRoute(route, method, body, conf.root);
    }

    // ── Storage (upload/download/binary) ─────────────────────
    if (route.startsWith("/api/storage/")) {
      return storage.handleRoute(route, method, headers, body);
    }

    // ── MCP endpoint ─────────────────────────────────────────
    if (route === "/mcp" || route.startsWith("/mcp/")) {
      return mcp.handleRoute(route, method, body, conf, token);
    }

    // ── Edit (single) ────────────────────────────────────────
    if (route === "/api/edit" && method === "POST") {
      return handleEdit(body);
    }

    // ── Multi-edit ───────────────────────────────────────────
    if (route === "/api/multi-edit" && method === "POST") {
      return handleMultiEdit(body);
    }

    // ── Glob ─────────────────────────────────────────────────
    if (route === "/api/glob" && method === "POST") {
      return handleGlob(body, conf.root);
    }

    // ── Grep ─────────────────────────────────────────────────
    if (route === "/api/grep" && method === "POST") {
      return handleGrep(body, conf.root);
    }

    // ── Search ───────────────────────────────────────────────
    if (route === "/api/search" && method === "POST") {
      return handleSearch(body, conf.root);
    }

    // ── Upload (binary) ──────────────────────────────────────
    if (route === "/api/upload" && method === "POST") {
      return storage.handleUpload(headers, body);
    }

    // ── Download (binary) ────────────────────────────────────
    if (route === "/api/download" && method === "POST") {
      return storage.handleDownload(body);
    }

    // ── Repo setup ───────────────────────────────────────────
    if (route.startsWith("/api/repo/")) {
      return repoSetup.handleRoute(route, method, body, conf.root);
    }

    // ── Code scan ────────────────────────────────────────────
    if (route === "/api/code-scan" && method === "POST") {
      return codeScan.handleRoute(body, conf.root);
    }

    // ── Deploy ───────────────────────────────────────────────
    if (route.startsWith("/api/deploy/")) {
      return deploy.handleRoute(route, method, body);
    }

    // ── Expose port ──────────────────────────────────────────
    if (route === "/api/expose-port" && method === "POST") {
      return exposePort.handleRoute(body);
    }

    // ── Recording ────────────────────────────────────────────
    if (route.startsWith("/api/recording/")) {
      return recording.handleRoute(route, method, body);
    }

    // ── Notebook ─────────────────────────────────────────────
    if (route === "/api/notebook" && method === "POST") {
      return notebook.handleRoute(body);
    }

    // ── Middleware hooks ──────────────────────────────────────
    if (route.startsWith("/api/middleware/")) {
      return middleware.handleRoute(route, method, body);
    }

    // ── Events ───────────────────────────────────────────────
    if (route === "/api/events/subscribe" && method === "POST") {
      return { status: 200, body: { ok: true, message: "Event subscription registered" } };
    }
    if (route === "/api/events/types") {
      return { status: 200, body: { types: middleware.getEventTypes() } };
    }

    // ── Identity ─────────────────────────────────────────────
    if (route === "/api/identity" && method === "POST") {
      return { status: 200, body: { ok: true, identity: body } };
    }

    // ── Scratchpad ───────────────────────────────────────────
    if (route.startsWith("/api/scratchpad/")) {
      return storage.handleScratchpad(route, method, body);
    }

    // ── Find ─────────────────────────────────────────────────
    if (route === "/api/find" && method === "POST") {
      return handleFind(body, conf.root);
    }

    // ── VNC management ───────────────────────────────────────
    if (route.startsWith("/api/vnc/")) {
      return novnc.handleApiRoute(route, method, body, log);
    }

    // ── code-server management ──────────────────────────────
    if (route === "/api/ide/status") {
      return {
        status: 200,
        body: {
          running: codeServer.isRunning(),
          port: codeServer.getPort(),
          password: codeServer.getPassword(),
          url: `/ide/`,
        },
      };
    }
    if (route === "/api/ide/start" && method === "POST") {
      const port = body.port || (conf.port + 1);
      const result = await codeServer.start(port, body.password || conf.vncPassword, body.workspace || conf.root, log, {
        connectionToken: conf.token,
      });
      return { status: result.ok ? 200 : 500, body: result };
    }
    if (route === "/api/ide/stop" && method === "POST") {
      codeServer.stop(log);
      return { status: 200, body: { ok: true } };
    }

    // ── Capabilities listing ────────────────────────────────
    if (route === "/api/capabilities") {
      return {
        status: 200,
        body: {
          version: "1.0.32",
          platform: process.platform,
          arch: os.arch(),
          hostname: os.hostname(),
          endpoints: {
            core: ["/api/exec", "/api/read", "/api/write", "/api/ls", "/api/info", "/api/screenshot", "/api/computer-use"],
            extended: ["/api/edit", "/api/multi-edit", "/api/glob", "/api/grep", "/api/search", "/api/find"],
            git: ["/api/git/status", "/api/git/clone", "/api/git/pull", "/api/git/push", "/api/git/diff", "/api/git/log",
                  "/api/git/checkout", "/api/git/branch", "/api/git/commit", "/api/git/add", "/api/git/fetch",
                  "/api/git/merge", "/api/git/rebase", "/api/git/remote", "/api/git/tag", "/api/git/blame",
                  "/api/git/show", "/api/git/rev-parse", "/api/git/config", "/api/git/creds/store", "/api/git/creds/helper"],
            storage: ["/api/storage/upload", "/api/storage/download", "/api/storage/restore",
                      "/api/storage/stat", "/api/storage/mkdir", "/api/storage/rename", "/api/storage/copy",
                      "/api/storage/delete", "/api/storage/exists", "/api/storage/hash"],
            mcp: ["/mcp"],
            repo: ["/api/repo/clone", "/api/repo/setup", "/api/repo/install", "/api/repo/build", "/api/repo/detect"],
            deploy: ["/api/deploy/upload", "/api/deploy/list", "/api/deploy/extract"],
            recording: ["/api/recording/start", "/api/recording/stop", "/api/recording/status"],
            notebook: ["/api/notebook"],
            vnc: ["/api/vnc/status", "/api/vnc/start", "/api/vnc/stop"],
            ide: ["/api/ide/status", "/api/ide/start", "/api/ide/stop"],
            websocket: ["/vnc-ws", "/pty-ws", "/cdp-ws"],
            web: ["/novnc/", "/ide/"],
            other: ["/api/code-scan", "/api/expose-port", "/api/middleware/*", "/api/events/*",
                    "/api/identity", "/api/scratchpad/*", "/api/ping", "/api/capabilities"],
          },
        },
      };
    }

    // ── Ping (RPC) ───────────────────────────────────────────
    if (route === "/api/ping") {
      return { status: 200, body: { pong: true, time: Date.now() } };
    }

    return null; // not handled
  };
}

// ── Edit (exact string replacement in file) ────────────────────────────────

function handleEdit(body) {
  const { file_path: fp, old_string, new_string } = body;
  if (!fp) return { status: 400, body: { error: "file_path required" } };
  try {
    let content = fs.readFileSync(fp, "utf8");
    if (old_string !== undefined && old_string !== null) {
      const idx = content.indexOf(old_string);
      if (idx === -1) return { status: 400, body: { error: "old_string not found in file" } };
      // Check uniqueness
      if (content.indexOf(old_string, idx + 1) !== -1) {
        return { status: 400, body: { error: "old_string is not unique in file" } };
      }
      content = content.slice(0, idx) + (new_string || "") + content.slice(idx + old_string.length);
    } else {
      content = new_string || "";
    }
    fs.writeFileSync(fp, content, "utf8");
    return { status: 200, body: { ok: true, path: fp, bytes: Buffer.byteLength(content) } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

// ── Multi-edit (multiple replacements in one file) ─────────────────────────

function handleMultiEdit(body) {
  const { file_path: fp, edits } = body;
  if (!fp) return { status: 400, body: { error: "file_path required" } };
  if (!Array.isArray(edits)) return { status: 400, body: { error: "edits must be an array" } };
  try {
    let content = fs.readFileSync(fp, "utf8");
    const results = [];
    for (const edit of edits) {
      const { old_string, new_string } = edit;
      const idx = content.indexOf(old_string);
      if (idx === -1) {
        results.push({ ok: false, error: "old_string not found" });
        continue;
      }
      content = content.slice(0, idx) + (new_string || "") + content.slice(idx + old_string.length);
      results.push({ ok: true });
    }
    fs.writeFileSync(fp, content, "utf8");
    return { status: 200, body: { ok: true, path: fp, results, bytes: Buffer.byteLength(content) } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

// ── Glob (file pattern matching) ───────────────────────────────────────────

async function handleGlob(body, root) {
  const pattern = body.pattern || body.glob || "**/*";
  const cwd = body.cwd || root;
  // Use find or PowerShell for glob
  const isWin = process.platform === "win32";
  const cmd = isWin
    ? `Get-ChildItem -Path '${cwd}' -Recurse -Name -File | Where-Object { $_ -like '${pattern}' } | Select-Object -First 1000`
    : `find ${shq(cwd)} -maxdepth ${body.max_depth || 10} -type f -name ${shq(pattern)} 2>/dev/null | head -1000`;
  const r = await core.runShell(cmd, cwd, 30000);
  const files = r.stdout.split("\n").filter(Boolean).map((f) => f.trim());
  return { status: 200, body: { pattern, cwd, files, count: files.length } };
}

// ── Grep (text search in files) ────────────────────────────────────────────

async function handleGrep(body, root) {
  const { pattern, path: searchPath, case_insensitive, max_results, context_lines } = body;
  if (!pattern) return { status: 400, body: { error: "pattern required" } };
  const cwd = searchPath || root;
  const isWin = process.platform === "win32";
  const maxR = max_results || 100;
  const ctx = context_lines || 0;
  const ci = case_insensitive ? (isWin ? "" : "-i") : "";

  let cmd;
  if (isWin) {
    cmd = `Select-String -Path '${cwd}\\*' -Pattern '${pattern}' -Recurse ${case_insensitive ? "-CaseSensitive:$false" : ""} | Select-Object -First ${maxR} | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`;
  } else {
    cmd = `grep -rn ${ci} ${ctx > 0 ? `-C ${ctx}` : ""} ${shq(pattern)} ${shq(cwd)} 2>/dev/null | head -${maxR}`;
  }
  const r = await core.runShell(cmd, root, 60000);
  const matches = r.stdout.split("\n").filter(Boolean);
  return { status: 200, body: { pattern, matches, count: matches.length } };
}

// ── Search (file content search with context) ──────────────────────────────

async function handleSearch(body, root) {
  // Alias for grep with extended options
  return handleGrep(body, root);
}

// ── Find (find files by name) ──────────────────────────────────────────────

async function handleFind(body, root) {
  const { name, path: searchPath, type: fileType } = body;
  if (!name) return { status: 400, body: { error: "name required" } };
  const cwd = searchPath || root;
  const isWin = process.platform === "win32";
  const typeFlag = fileType === "d" ? "-type d" : fileType === "f" ? "-type f" : "";

  const cmd = isWin
    ? `Get-ChildItem -Path '${cwd}' -Recurse -Name ${fileType === "d" ? "-Directory" : "-File"} -Filter '${name}' | Select-Object -First 200`
    : `find ${shq(cwd)} -maxdepth 8 ${typeFlag} -name ${shq(name)} 2>/dev/null | head -200`;
  const r = await core.runShell(cmd, root, 30000);
  const files = r.stdout.split("\n").filter(Boolean).map((f) => f.trim());
  return { status: 200, body: { name, files, count: files.length } };
}

function shq(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
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

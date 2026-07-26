"use strict";
// dev-agent · vnc-setup — Auto-detect/install VNC server, start it.
// Linux: x11vnc or TigerVNC. Windows: TightVNC or built-in RDP.

const { execSync, spawn } = require("child_process");
const net = require("net");
const os = require("os");
const fs = require("fs");
const tightvnc = require("./tightvnc.js");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

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

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function waitForTcp(host, port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const probe = () => new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    const done = (ok) => {
      if (finished) return;
      finished = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.on("close", () => {
      if (!finished) done(false);
    });
  });

  return (async () => {
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  })();
}

// ── Linux VNC ──────────────────────────────────────────────────────────────

function detectLinuxVnc() {
  if (which("x11vnc")) return "x11vnc";
  if (which("Xvnc") || which("vncserver")) return "tigervnc";
  return null;
}

function installLinuxVnc(log) {
  log("[vnc] No VNC server found, attempting install...");
  try {
    execSync("apt-get update -qq && apt-get install -y -qq x11vnc 2>&1", {
      encoding: "utf8",
      timeout: 120000,
      stdio: "pipe",
    });
    log("[vnc] x11vnc installed successfully");
    return "x11vnc";
  } catch (e) {
    log("[vnc] apt install failed: " + (e.message || e));
  }
  try {
    execSync("yum install -y x11vnc 2>&1 || dnf install -y x11vnc 2>&1", {
      encoding: "utf8",
      timeout: 120000,
      stdio: "pipe",
    });
    log("[vnc] x11vnc installed via yum/dnf");
    return "x11vnc";
  } catch {
    log("[vnc] Cannot auto-install VNC server. Please install x11vnc or tigervnc-server manually.");
    return null;
  }
}

function startLinuxVnc(vncType, port, password, log) {
  const display = process.env.DISPLAY || ":0";
  let proc;

  if (vncType === "x11vnc") {
    const args = [
      "-display", display,
      "-rfbport", String(port),
      "-shared",
      "-forever",
      "-noxdamage",
      "-noncache",
    ];
    if (password) {
      // Write password to a temp file
      const pwFile = `/tmp/.clouddev-vnc-passwd-${process.pid}`;
      try {
        execSync(`x11vnc -storepasswd ${password} ${pwFile}`, { timeout: 5000, stdio: "pipe" });
        args.push("-rfbauth", pwFile);
      } catch {
        args.push("-passwd", password);
      }
    } else {
      args.push("-nopw");
    }
    log(`[vnc] Starting x11vnc on display ${display} port ${port}`);
    proc = spawn("x11vnc", args, { stdio: "pipe", detached: false });
  } else if (vncType === "tigervnc") {
    // TigerVNC standalone server (x0vncserver mirrors an existing X display).
    // -AlwaysShared: x0vncserver is single-client by default, so a stale/zombie
    // proxy connection (or a reconnect racing the old socket's teardown) would
    // permanently occupy the only slot — new clients then get a degraded
    // RFB 003.003 handshake and fail with "连接异常断开". Sharing avoids this.
    const args = ["-rfbport", String(port), "-AlwaysShared"];
    let useAuth = false;
    if (password) {
      // x0vncserver with VncAuth requires a -PasswordFile, otherwise it blocks
      // on an interactive prompt and never binds the port. Materialise the
      // password into an obfuscated file via {tiger,}vncpasswd -f.
      const pwFile = `/tmp/.clouddev-vnc-passwd-${process.pid}`;
      const tool = which("tigervncpasswd") || which("vncpasswd");
      if (tool) {
        try {
          execSync(`${tool} -f > ${pwFile}`, {
            input: password + "\n",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          try { fs.chmodSync(pwFile, 0o600); } catch {}
          args.push("-SecurityTypes", "VncAuth", "-PasswordFile", pwFile);
          useAuth = true;
        } catch (e) {
          log("[vnc] vncpasswd failed, falling back to no auth: " + (e.message || e));
        }
      }
    }
    if (!useAuth) args.push("-SecurityTypes", "None");
    args.push(display);
    log(`[vnc] Starting TigerVNC on display ${display} port ${port} (auth=${useAuth})`);
    proc = spawn("x0vncserver", args, { stdio: "pipe", detached: false });
  }

  if (proc) {
    proc.on("error", (err) => log("[vnc] VNC server process error: " + err.message));
    proc.stdout?.on("data", (d) => log("[vnc:stdout] " + d.toString().trim()));
    proc.stderr?.on("data", (d) => log("[vnc:stderr] " + d.toString().trim()));
    proc.on("exit", (code) => log(`[vnc] VNC server exited with code ${code}`));
  }

  return proc;
}

// ── Windows VNC ────────────────────────────────────────────────────────────

function detectWindowsVnc() {
  // Check for TightVNC
  if (which("tvnserver") || which("tvnserver.exe")) return "tightvnc";
  // Check common install paths
  const paths = [
    "C:\\Program Files\\TightVNC\\tvnserver.exe",
    "C:\\Program Files (x86)\\TightVNC\\tvnserver.exe",
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return "tightvnc";
  }
  // Check for UltraVNC
  if (which("winvnc") || which("winvnc.exe")) return "ultravnc";
  return null;
}

function startWindowsVnc(vncType, port, password, log) {
  log(`[vnc] Windows VNC type: ${vncType || "none"}`);
  if (!vncType) {
    log("[vnc] No VNC server detected on Windows. Please install TightVNC or UltraVNC.");
    log("[vnc] Download: https://www.tightvnc.com/download.php");
    return null;
  }
  // TightVNC is typically run as a service; we just ensure it's running
  log("[vnc] Using existing Windows VNC server installation");
  return null; // Let the existing VNC service handle it
}

// ── Xvfb for headless ──────────────────────────────────────────────────────

function ensureXvfb(display, log) {
  // Ensure openbox, xterm, xdotool, x11-xserver-utils are installed if on Linux
  if (!isWin && !isMac && (!which("openbox") || !which("xdotool"))) {
    try {
      log("[vnc] Installing openbox, xterm, xdotool, x11-xserver-utils...");
      execSync("apt-get update -qq && apt-get install -y openbox xterm xdotool x11-xserver-utils 2>&1", {
        timeout: 120000,
        stdio: "pipe",
      });
    } catch (e) {
      log("[vnc] Warning installing desktop tools: " + (e.message || e));
    }
  }

  const startWmAndBackground = () => {
    process.env.DISPLAY = display;
    try {
      execSync(`DISPLAY=${display} xsetroot -solid grey61 2>/dev/null`, { timeout: 3000, stdio: "ignore" });
    } catch {}
    try {
      const wmProc = spawn("openbox", [], {
        env: { ...process.env, DISPLAY: display },
        stdio: "ignore",
        detached: true,
      });
      wmProc.unref();
      log(`[vnc] Started openbox window manager on ${display}`);
    } catch {}
  };

  // Check if X display is already available
  try {
    execSync(`xdpyinfo -display ${display} 2>/dev/null`, { timeout: 3000, stdio: "pipe" });
    log(`[vnc] X display ${display} is available`);
    startWmAndBackground();
    return null;
  } catch {}

  // No X display — start Xvfb
  if (!which("Xvfb")) {
    log("[vnc] No X display and Xvfb not available. Trying to install...");
    try {
      execSync("apt-get update -qq && apt-get install -y -qq xvfb 2>&1", { timeout: 60000, stdio: "pipe" });
    } catch {
      log("[vnc] Cannot install Xvfb. VNC requires an X display.");
      return null;
    }
  }

  if (!which("Xvfb")) {
    log("[vnc] Xvfb binary not found. Cannot start virtual X display.");
    return null;
  }

  const resolution = "1920x1080x24";
  log(`[vnc] Starting Xvfb on ${display} at ${resolution}`);
  let proc;
  try {
    proc = spawn("Xvfb", [display, "-screen", "0", resolution, "-ac"], {
      stdio: "pipe",
      detached: false,
    });
    proc.on("error", (err) => log(`[vnc] Xvfb process error: ${err.message}`));
    proc.on("exit", (code) => log(`[vnc] Xvfb exited with code ${code}`));
  } catch (e) {
    log(`[vnc] Failed to spawn Xvfb: ${e.message}`);
    return null;
  }
  // Give it a moment to start
  try { execSync("sleep 1"); } catch {}
  startWmAndBackground();
  return proc;
}

// Free the VNC port before (re)starting. A previous agent's VNC server keeps
// running after the agent process is replaced (e.g. on restart); the new server
// then fails to bind and the stale one — which still trusts the *old* token as
// its VNC password — keeps answering, so clients authenticate with the current
// token and get rejected ("连接异常断开"). Kill whatever still holds the port so
// the fresh server binds and its password matches the live token.
function freeVncPort(port, log) {
  const pids = new Set();
  const tryCmd = (cmd) => {
    try {
      const out = execSync(cmd, { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
        .toString();
      for (const m of out.matchAll(/(\d+)/g)) pids.add(m[1]);
    } catch {}
  };
  // Prefer fuser/lsof; fall back to parsing ss output for the pid=NNN field.
  tryCmd(`fuser ${port}/tcp 2>/dev/null`);
  tryCmd(`lsof -ti tcp:${port} 2>/dev/null`);
  if (pids.size === 0) {
    try {
      const out = execSync(`ss -ltnpH 'sport = :${port}'`, {
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(m[1]);
    } catch {}
  }
  for (const pid of pids) {
    if (String(pid) === String(process.pid)) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      log(`[vnc] Freed port ${port}: terminated stale server pid ${pid}`);
    } catch {}
  }
  if (pids.size) {
    try { execSync("sleep 1"); } catch {}
  }
}

// ── macOS VNC ──────────────────────────────────────────────────────────────
// macOS has a built-in VNC server (Screen Sharing / Remote Management).
// When enabled it listens on port 5900. We detect it instead of trying to
// install x11vnc/TigerVNC (which don't ship with macOS).

function detectMacVnc(port, log) {
  // Check if macOS Screen Sharing is enabled and listening on the VNC port.
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5000,
    });
    if (out.trim()) {
      log(`[vnc] macOS: existing VNC server detected on port ${port}`);
      return "macos-screensharing";
    }
  } catch {}
  // Also try the traditional check for Screen Sharing via launchctl.
  try {
    const out = execSync("launchctl list com.apple.screensharing 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
    });
    if (out.includes("PID") || /^\d+/m.test(out)) {
      log("[vnc] macOS Screen Sharing service is running");
      return "macos-screensharing";
    }
  } catch {}
  return null;
}

function enableMacVnc(port, log) {
  // Attempt to enable Screen Sharing via kickstart (requires sudo, may fail).
  try {
    execSync(
      "sudo -n /System/Library/CoreServices/RemoteManagement/ARDAgent.app" +
      "/Contents/Resources/kickstart -activate -configure -access -on" +
      " -restart -agent -privs -all 2>&1",
      { encoding: "utf8", timeout: 15000, stdio: "pipe" },
    );
    log("[vnc] macOS Screen Sharing enabled via kickstart");
    // Give the server a moment to bind.
    try { execSync("sleep 1"); } catch {}
    return "macos-screensharing";
  } catch (e) {
    log("[vnc] macOS: cannot auto-enable Screen Sharing (needs admin): " + (e.message || e));
    log("[vnc] 请在 系统设置 → 通用 → 共享 → 屏幕共享 中手动开启");
  }
  return null;
}

// ── Main setup ─────────────────────────────────────────────────────────────

async function setupVnc(opts, log) {
  const port = opts.vncPort || 5900;
  const password = opts.vncPassword || "";

  if (isWin) {
    const portable = await tightvnc.startPortableTightVnc(log);
    if (portable && portable.ok) {
      return {
        port: portable.port || 5901,
        host: portable.host || "127.0.0.1",
        proc: portable.proc || null,
        cleanup: portable.cleanup || null,
        auth: portable.auth || "none",
        type: "tightvnc-portable",
      };
    }

    const vncType = detectWindowsVnc();
    if (vncType) {
      const lanIp = getLocalIp();
      const loopbackOpen = await waitForTcp("127.0.0.1", port, 1500);
      if (loopbackOpen) {
        log(`[vnc] Existing Windows VNC detected on loopback port ${port}`);
        return { port, host: "127.0.0.1", proc: null, type: vncType };
      }
      const lanOpen = await waitForTcp(lanIp, port, 1500);
      if (lanOpen) {
        log(`[vnc] Existing Windows VNC detected on LAN host ${lanIp}:${port}`);
        return { port, host: lanIp, proc: null, type: vncType };
      }
      log(`[vnc] Windows VNC detected (${vncType}) but port ${port} is not accepting connections`);
    }
    return { port, host: "127.0.0.1", proc: null, type: "none" };
  }

  if (isMac) {
    // macOS: detect built-in Screen Sharing (port 5900 by default).
    let vncType = detectMacVnc(port, log);
    if (!vncType) vncType = enableMacVnc(port, log);
    if (vncType) {
      // macOS Screen Sharing is its own process; we just proxy to its port.
      return { port, host: "127.0.0.1", proc: null, type: vncType };
    }
    log("[vnc] macOS: VNC server unavailable, VNC tab will be disabled");
    return { port, host: "127.0.0.1", proc: null, type: "none" };
  }

  // Linux
  let xvfbProc = null;
  const display = process.env.DISPLAY || ":0";

  // Ensure X display exists (start Xvfb if headless)
  xvfbProc = ensureXvfb(display, log);

  let vncType = detectLinuxVnc();
  if (!vncType) {
    vncType = installLinuxVnc(log);
  }
  if (!vncType) {
    return { port, host: "127.0.0.1", proc: null, xvfb: xvfbProc, type: "none" };
  }

  freeVncPort(port, log);
  const proc = startLinuxVnc(vncType, port, password, log);
  return { port, host: "127.0.0.1", proc, xvfb: xvfbProc, type: vncType };
}

module.exports = { setupVnc, detectLinuxVnc, detectWindowsVnc, detectMacVnc, installLinuxVnc };

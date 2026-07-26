"use strict";
// dev-agent · core — HTTP server + unified routing
// Zero dependencies beyond Node built-ins. Cross-platform (Linux/Windows).

const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const os = require("os");
const { execFile, spawn } = require("child_process");
const computer = require("./computer.js");

const isWin = process.platform === "win32";

// ── Shell helpers ──────────────────────────────────────────────────────────

function shq(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
}

function wrapPwsh(cmd) {
  return (
    "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
    "$ErrorActionPreference='Continue'; $Error.Clear(); $global:LASTEXITCODE=0\n" +
    cmd +
    "\n$__c=0; if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){$__c=$LASTEXITCODE}" +
    " elseif($Error.Count -gt 0){$__c=1}; exit $__c"
  );
}

const SHELL_SESSION_IDLE_MS = 10 * 60 * 1000;
const shellSessions = new Map();

function psq(value) {
  return "'" + String(value == null ? "" : value).replace(/'/g, "''") + "'";
}

function closeShellSession(id, state) {
  if (shellSessions.get(id) === state) shellSessions.delete(id);
  state.closed = true;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  try { state.proc.kill(); } catch {}
}

function touchShellSession(id, state) {
  state.lastUsed = Date.now();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (shellSessions.get(id) === state && Date.now() - state.lastUsed >= SHELL_SESSION_IDLE_MS) {
      closeShellSession(id, state);
    }
  }, SHELL_SESSION_IDLE_MS);
}

function createShellSession(id, cwd) {
  const shell = isWin ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
  const args = isWin
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]
    : ["-s"];
  const state = {
    proc: spawn(shell, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
    stdout: "",
    stderr: "",
    queue: Promise.resolve(),
    cwd: cwd || process.cwd(),
    closed: false,
    idleTimer: null,
    lastUsed: Date.now(),
  };
  state.proc.stdout.on("data", (chunk) => { state.stdout += chunk.toString("utf8"); });
  state.proc.stderr.on("data", (chunk) => { state.stderr += chunk.toString("utf8"); });
  state.proc.on("error", (err) => { state.error = err; });
  state.proc.on("exit", () => { state.closed = true; });
  shellSessions.set(id, state);
  touchShellSession(id, state);
  return state;
}

function runPersistentShell(cmd, cwd, timeoutMs, id, defaultCwd) {
  let state = shellSessions.get(id);
  if (!state || state.closed) state = createShellSession(id, cwd || defaultCwd || process.cwd());
  state.queue = state.queue.catch(() => {}).then(() => new Promise((resolve) => {
    if (state.closed || state.error) {
      closeShellSession(id, state);
      resolve({ stdout: "", stderr: String((state.error && state.error.message) || "shell session exited"), exit_code: 1 });
      return;
    }
    const marker = `__CLOUDDEV_SESSION_${crypto.randomBytes(12).toString("hex")}__`;
    const command = isWin
      ? `${cwd ? `Set-Location -LiteralPath ${psq(cwd)}\n` : ""}$global:LASTEXITCODE=0\n${cmd}\n$__clouddevSuccess = $?\n$__clouddevStatus = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($__clouddevSuccess) { 0 } else { 1 }\nWrite-Output '${marker}'\nWrite-Output $__clouddevStatus\nWrite-Output ((Get-Location).Path)\n`
      : `${cwd ? `cd -- ${shq(cwd)}\n` : ""}${cmd}\n__clouddev_status=$?\nprintf '\\n${marker}\\n%s\\n%s\\n' "$__clouddev_status" "$PWD"\n`;
    state.stdout = "";
    state.stderr = "";
    touchShellSession(id, state);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const output = state.stdout.replace(/\r\n/g, "\n");
      const markerIndex = output.indexOf(`\n${marker}\n`);
      if (markerIndex < 0) {
        resolve(result || { stdout: output, stderr: state.stderr, exit_code: 1 });
        return;
      }
      const prefix = output.slice(0, markerIndex);
      const tail = output.slice(markerIndex + marker.length + 2).split("\n");
      const exitCode = Number.parseInt(tail[0], 10);
      const nextCwd = tail[1] || state.cwd;
      state.cwd = nextCwd;
      resolve({ stdout: prefix, stderr: state.stderr, exit_code: Number.isFinite(exitCode) ? exitCode : 1 });
    };
    let poll;
    const timer = setTimeout(() => {
      closeShellSession(id, state);
      clearInterval(poll);
      finish({ stdout: state.stdout, stderr: state.stderr || "timeout", exit_code: 1 });
    }, timeoutMs);
    state.proc.stdin.write(command, "utf8", (err) => {
      if (err) {
        clearTimeout(timer);
        finish({ stdout: state.stdout, stderr: String(err.message || err), exit_code: 1 });
      }
    });
    poll = setInterval(() => {
      const output = state.stdout.replace(/\r\n/g, "\n");
      if (output.includes(`\n${marker}\n`)) {
        clearInterval(poll);
        clearTimeout(timer);
        finish();
      } else if (state.closed) {
        clearInterval(poll);
        clearTimeout(timer);
        finish({ stdout: output, stderr: state.stderr, exit_code: 1 });
      }
    }, 10);
  }));
  return state.queue;
}

function runShell(cmd, cwd, timeoutMs, sessionId, defaultCwd, env) {
  if (sessionId) return runPersistentShell(cmd, cwd, timeoutMs, String(sessionId), defaultCwd);
  return new Promise((resolve) => {
    const shell = isWin ? "powershell.exe" : "/bin/sh";
    const args = isWin ? ["-NoProfile", "-Command", wrapPwsh(cmd)] : ["-c", cmd];
    execFile(
      shell,
      args,
      {
        cwd: cwd || defaultCwd || process.cwd(),
        env: env ? { ...process.env, ...env } : process.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || (err && err.killed ? "timeout" : ""),
          exit_code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        });
      }
    );
  });
}

// ── Computer Use (screenshot / mouse / keyboard) ──────────────────────────

async function handleComputerUse(body) {
  return computer.handleComputerUse(body, {
    runShell,
    ensureCdpBrowser,
    getCdpPageWsUrl,
    cdpHttpGetJson,
    wsClientConnect,
    wsFrameMasked,
    makeWsMsgReader,
    log: console.error,
  });
}

async function computerUseLinux(action, body) {
  switch (action) {
    case "screenshot": {
      const tmpFile = `/tmp/clouddev-screenshot-${Date.now()}.png`;
      const r = await runShell(
        `export DISPLAY=:0; scrot ${shq(tmpFile)} 2>/dev/null || maim ${shq(tmpFile)} 2>/dev/null || import -window root ${shq(tmpFile)} 2>/dev/null`,
        undefined,
        10000
      );
      if (r.exit_code !== 0) return { error: "screenshot failed: " + r.stderr, exit_code: r.exit_code };
      try {
        const data = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        return { image: data.toString("base64"), format: "png" };
      } catch (e) {
        return { error: "read screenshot failed: " + e.message };
      }
    }
    case "click": {
      const [x, y] = body.coordinate || [0, 0];
      const btn = body.button === "right" ? "3" : "1";
      const r = await runShell(`export DISPLAY=:0; xdotool mousemove ${x} ${y} click ${btn}`, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "double_click": {
      const [x, y] = body.coordinate || [0, 0];
      const r = await runShell(`export DISPLAY=:0; xdotool mousemove ${x} ${y} click --repeat 2 1`, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "type": {
      const text = body.text || "";
      const r = await runShell(`export DISPLAY=:0; xdotool type --delay 12 -- ${shq(text)}`, undefined, 30000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "key": {
      const key = body.key || "";
      const r = await runShell(`export DISPLAY=:0; xdotool key -- ${shq(key)}`, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "scroll": {
      const [x, y] = body.coordinate || [512, 384];
      const dir = body.scroll_direction || "down";
      const clicks = body.scroll_amount || 3;
      const btn = dir === "up" || dir === "left" ? "4" : "5";
      const r = await runShell(
        `export DISPLAY=:0; xdotool mousemove ${x} ${y} click --repeat ${clicks} ${btn}`,
        undefined,
        5000
      );
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "move": {
      const [x, y] = body.coordinate || [0, 0];
      const r = await runShell(`export DISPLAY=:0; xdotool mousemove ${x} ${y}`, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "resolution": {
      const r = await runShell(`export DISPLAY=:0; xdpyinfo | grep dimensions`, undefined, 5000);
      const m = r.stdout.match(/(\d+)x(\d+)/);
      return m ? { width: parseInt(m[1]), height: parseInt(m[2]) } : { error: "cannot detect", raw: r.stdout };
    }
    default:
      return { error: `unknown action: ${action}` };
  }
}

// Shared C# helper for Windows mouse operations (loaded once per process).
const WIN_MOUSE_CS = `
using System; using System.Runtime.InteropServices;
public class CloudDevMouse {
  [DllImport("user32.dll")] static extern void mouse_event(uint f,int x,int y,int d,int e);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  const uint DOWN_L=0x02, UP_L=0x04, DOWN_R=0x08, UP_R=0x10, WHEEL=0x0800;
  public static void Move(int x,int y){ SetCursorPos(x,y); }
  public static void Click(int x,int y,bool right){
    SetCursorPos(x,y);
    mouse_event(right?DOWN_R:DOWN_L,0,0,0,0);
    mouse_event(right?UP_R:UP_L,0,0,0,0);
  }
  public static void DoubleClick(int x,int y){
    SetCursorPos(x,y);
    mouse_event(DOWN_L,0,0,0,0); mouse_event(UP_L,0,0,0,0);
    mouse_event(DOWN_L,0,0,0,0); mouse_event(UP_L,0,0,0,0);
  }
  public static void Scroll(int x,int y,int delta){
    SetCursorPos(x,y);
    mouse_event(WHEEL,0,0,delta,0);
  }
}
`;

async function computerUseWindows(action, body) {
  switch (action) {
    case "screenshot": {
      const tmpFile = path.join(os.tmpdir(), `clouddev-screenshot-${Date.now()}.png`);
      const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s = [Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object Drawing.Bitmap($s.Width,$s.Height)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($s.Location,[Drawing.Point]::Empty,$s.Size)
$g.Dispose()
$bmp.Save('${tmpFile.replace(/'/g, "''")}','Png')
$bmp.Dispose()
[Convert]::ToBase64String([IO.File]::ReadAllBytes('${tmpFile.replace(/'/g, "''")}'))
`;
      const r = await runShell(ps, undefined, 15000);
      try { fs.unlinkSync(tmpFile); } catch {}
      if (r.exit_code !== 0) return { error: "screenshot failed: " + r.stderr };
      return { image: r.stdout.trim(), format: "png" };
    }
    case "click": {
      const [x, y] = body.coordinate || [0, 0];
      const ps = `
Add-Type @'
${WIN_MOUSE_CS}
'@
[CloudDevMouse]::Click(${x},${y},${body.button === "right" ? "$true" : "$false"})
`;
      const r = await runShell(ps, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "double_click": {
      const [x, y] = body.coordinate || [0, 0];
      const ps = `
Add-Type @'
${WIN_MOUSE_CS}
'@
[CloudDevMouse]::DoubleClick(${x},${y})
`;
      const r = await runShell(ps, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "scroll": {
      const [x, y] = body.coordinate || [512, 384];
      const dir = body.scroll_direction || "down";
      const clicks = body.scroll_amount || 3;
      // WHEEL_DELTA = 120 per notch; negative = scroll down.
      const delta = (dir === "up" || dir === "left" ? 1 : -1) * clicks * 120;
      const ps = `
Add-Type @'
${WIN_MOUSE_CS}
'@
[CloudDevMouse]::Scroll(${x},${y},${delta})
`;
      const r = await runShell(ps, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "move": {
      const [x, y] = body.coordinate || [0, 0];
      const ps = `
Add-Type @'
${WIN_MOUSE_CS}
'@
[CloudDevMouse]::Move(${x},${y})
`;
      const r = await runShell(ps, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "type": {
      const text = body.text || "";
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.SendKeys]::SendWait('${text.replace(/[+^%~(){}[\]]/g, "{$&}")}')
`;
      const r = await runShell(ps, undefined, 10000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "key": {
      const key = body.key || "";
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.SendKeys]::SendWait('${key}')
`;
      const r = await runShell(ps, undefined, 5000);
      return { ok: r.exit_code === 0, stderr: r.stderr };
    }
    case "resolution": {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
$s = [Windows.Forms.Screen]::PrimaryScreen.Bounds
"$($s.Width)x$($s.Height)"
`;
      const r = await runShell(ps, undefined, 5000);
      const m = r.stdout.trim().match(/(\d+)x(\d+)/);
      return m ? { width: parseInt(m[1]), height: parseInt(m[2]) } : { error: "cannot detect" };
    }
    default:
      return { error: `unknown action on windows: ${action}` };
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────

function checkAuth(headers, token) {
  const h = headers["authorization"] || headers["Authorization"] || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!token && bearer === token;
}

// ── Route handler ──────────────────────────────────────────────────────────

async function handleRoute(host, route, method, headers, bodyRaw, token) {
  const root = host.workspaceRoot();
  let body = {};
  try { body = bodyRaw ? JSON.parse(bodyRaw) : {}; } catch { body = {}; }

  // Health (unauthenticated)
  if (route === "/api/health" || route === "/health") {
    const caps = ["exec", "pty", "screenshot", "computer_use"];
    if (host.vncPort && host.vncPort()) caps.push("vnc");
    if (host.idePort && host.idePort()) caps.push("code_server");
    return {
      status: 200,
      body: {
        status: "ok",
        service: "dev-agent",
        version: "1.0.32",
        platform: process.platform,
        host: os.hostname(),
        workspace: root,
        vnc_port: host.vncPort ? host.vncPort() : null,
        ide_port: host.idePort ? host.idePort() : null,
        ws_vnc_path: "/vnc-ws",
        ws_pty_path: "/pty-ws",
        capabilities: caps,
        pid: process.pid,
      },
    };
  }

  // CORS preflight
  if (method === "OPTIONS") return { status: 204, body: {} };

  // All other routes require auth
  if (!checkAuth(headers, token))
    return { status: 401, body: { error: "unauthorized" } };

  // ── Shell exec ────────────────────────────────────────────
  if ((route === "/api/exec" || route === "/api/exec-sync") && method === "POST") {
    const cmd = body.cmd || body.command || "";
    if (!cmd) return { status: 400, body: { error: "cmd required" } };
    const timeoutMs = ((body.timeout && Number(body.timeout)) || 30) * 1000;
    const r = await runShell(cmd, body.cwd, timeoutMs, body.session, root, body.env);
    return { status: 200, body: { status: "completed", result: r } };
  }

  // ── File read ─────────────────────────────────────────────
  if (route === "/api/read" && method === "POST") {
    const p = body.path || "";
    try {
      const stat = fs.statSync(p);
      if (stat.size > 10 * 1024 * 1024)
        return { status: 413, body: { error: "file too large (>10MB)" } };
      return { status: 200, body: { path: p, content: fs.readFileSync(p, "utf8"), size: stat.size } };
    } catch (e) {
      return { status: 404, body: { error: String(e.message || e) } };
    }
  }

  // ── File write ────────────────────────────────────────────
  if (route === "/api/write" && method === "POST") {
    const p = body.path || "";
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body.content ?? "", "utf8");
      return { status: 200, body: { ok: true, path: p, bytes: Buffer.byteLength(body.content ?? "") } };
    } catch (e) {
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  // ── Directory listing ─────────────────────────────────────
  if (route === "/api/ls" && method === "POST") {
    const p = body.path || root;
    try {
      const items = fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
        name: d.name,
        dir: d.isDirectory(),
        size: d.isDirectory() ? 0 : (() => { try { return fs.statSync(path.join(p, d.name)).size; } catch { return 0; } })(),
      }));
      return { status: 200, body: { path: p, items } };
    } catch (e) {
      return { status: 404, body: { error: String(e.message || e) } };
    }
  }

  // ── System info ───────────────────────────────────────────
  if (route === "/api/info") {
    return {
      status: 200,
      body: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: os.arch(),
        cpus: os.cpus().length,
        memory_gb: Math.round(os.totalmem() / 1073741824 * 10) / 10,
        uptime_hours: Math.round(os.uptime() / 3600 * 10) / 10,
        workspace: root,
        user: os.userInfo().username,
        node: process.version,
      },
    };
  }

  // ── Computer Use ──────────────────────────────────────────
  if (route === "/api/computer-use" && method === "POST") {
    const result = await handleComputerUse(body);
    return { status: result.error ? 500 : 200, body: result };
  }

  // ── Screenshot (shorthand) ────────────────────────────────
  if (route === "/api/screenshot") {
    const result = await handleComputerUse({ action: "screenshot" });
    return { status: result.error ? 500 : 200, body: result };
  }

  return { status: 404, body: { error: "not_found", route } };
}

// ── VNC WebSocket proxy (websockify) ──────────────────────────────────────
// Upgrades HTTP to raw TCP proxy to the local VNC server. This lets noVNC
// connect via WebSocket on the same port as the HTTP API.

function setupVncProxy(server, vncPort, token, vncHost = "127.0.0.1") {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    // Only handle the VNC path; leave other upgrades (e.g. /pty-ws) for their
    // own listener. (Node invokes every "upgrade" listener, so destroying the
    // socket here would kill PTY connections.)
    if (url.pathname !== "/vnc-ws") return;

    // Auth check via query param, header, or Sec-WebSocket-Protocol
    const qToken = url.searchParams.get("token") || url.searchParams.get("tkn");
    const hAuth = req.headers["authorization"] || "";
    const hBearer = hAuth.startsWith("Bearer ") ? hAuth.slice(7) : "";
    const secProto = String(req.headers["sec-websocket-protocol"] || "");
    const protoList = secProto.split(",").map((s) => s.trim()).filter(Boolean);

    let authorized = !token;
    if (token) {
      if (qToken === token || hBearer === token) authorized = true;
      if (protoList.includes(token)) authorized = true;
      for (const p of protoList) {
        if (p === token || p === `token.${token}` || p.startsWith(`${token}.`)) authorized = true;
      }
    }

    if (!authorized) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // WebSocket handshake
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const acceptKey = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    // Only echo a subprotocol the client actually offered. Returning a
    // subprotocol the client did not request makes strict clients (WebKitGTK,
    // modern noVNC) abort with "Server requested unsupported protocol".
    const offered = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const selected = offered.includes("binary") ? "binary" : null;

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      (selected ? `Sec-WebSocket-Protocol: ${selected}\r\n` : "") +
      "\r\n"
    );

    // Connect to local VNC
    const vnc = net.createConnection({ host: vncHost, port: vncPort }, () => {
      if (head && head.length) vnc.write(head);
    });

    // WebSocket frame helpers (binary frames for VNC/RFB)
    let wsBuf = Buffer.alloc(0);
    const wsToTcp = (data) => {
      wsBuf = Buffer.concat([wsBuf, data]);
      let offset = 0;
      while (offset < wsBuf.length) {
        if (wsBuf.length - offset < 2) break;
        const byte1 = wsBuf[offset + 1];
        const masked = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7f;
        let headerLen = 2;
        if (payloadLen === 126) {
          if (wsBuf.length - offset < 4) break;
          payloadLen = wsBuf.readUInt16BE(offset + 2);
          headerLen = 4;
        } else if (payloadLen === 127) {
          if (wsBuf.length - offset < 10) break;
          payloadLen = Number(wsBuf.readBigUInt64BE(offset + 2));
          headerLen = 10;
        }
        if (masked) headerLen += 4;
        const totalLen = headerLen + payloadLen;
        if (wsBuf.length - offset < totalLen) break;

        const payload = wsBuf.slice(offset + headerLen, offset + totalLen);
        if (masked) {
          const maskKey = wsBuf.slice(offset + headerLen - 4, offset + headerLen);
          for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
        }

        const opcode = wsBuf[offset] & 0x0f;
        if (opcode === 0x08) { // close
          vnc.end();
          socket.end();
          return;
        }
        if (opcode === 0x02 || opcode === 0x00) { // binary or continuation
          vnc.write(payload);
        }
        offset += totalLen;
      }
      if (offset > 0) wsBuf = wsBuf.slice(offset);
    };

    const tcpToWs = (data) => {
      // Build binary WebSocket frame
      const len = data.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x82; // fin + binary
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x82;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      try {
        socket.write(header);
        socket.write(data);
      } catch {}
    };

    socket.on("data", wsToTcp);
    vnc.on("data", tcpToWs);
    vnc.on("error", () => socket.destroy());
    vnc.on("close", () => socket.destroy());
    socket.on("error", () => vnc.destroy());
    socket.on("close", () => vnc.destroy());
  });
}

// ── Interactive PTY WebSocket (real terminal) ─────────────────────────────
// Streams a real login shell running inside a pseudo-terminal over a WebSocket
// so the client (xterm.js) gets a native interactive terminal: colours, line
// editing, tab-completion, Ctrl-C, and full-screen TUIs (vim/htop/top).
//
// A PTY is allocated without any native dependency: on Linux/macOS we run the
// shell under util-linux `script`, which gives it a controlling pseudo-tty; on
// Windows we fall back to a piped PowerShell (no conpty, but interactive I/O
// still works). Wire protocol: client → server *binary* frames are raw stdin;
// client → server *text* frames are JSON control messages ({type:"resize"}).
// Server → client output is sent as binary frames.

// Minimal RFC6455 frame codec (server side: read masked client frames, write
// unmasked server frames). Handles fragmentation of inbound frames.
function makeWsReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.slice(off + maskLen + len);
      onFrame(opcode, payload);
    }
  };
}

function wsFrame(data, opcode) {
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

// Spawn a login shell attached to a pseudo-terminal. Returns the child process
// plus a `resize(cols, rows)` hook. Window size is established up front via
// `stty` (run inside the pty before the shell is exec'd, so it produces no
// visible output) and re-applied on resize.
function spawnPtyShell(cols, rows, cwd) {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  if (isWin) {
    const proc = spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
      cwd,
      env,
      windowsHide: true,
    });
    return { proc, resize() {} };
  }
  const shell = process.env.SHELL || "/bin/bash";
  const isMac = process.platform === "darwin";
  let proc;
  if (isMac) {
    // macOS `script` has different flags: `script -q /dev/null <cmd> <args>`
    // -q: quiet; no start/stop messages. The command runs inside a fresh pty.
    proc = spawn("script", ["-q", "/dev/null", shell, "-l"], { cwd, env });
    // Apply initial terminal size once the pty is ready.
    setTimeout(() => {
      try { proc.stdin.write(`stty rows ${rows} cols ${cols} 2>/dev/null\n`); } catch {}
    }, 100);
  } else {
    // util-linux `script -qfc <cmd> /dev/null` runs <cmd> inside a fresh pty.
    // Size the pty first (silent), then replace the wrapper with a login shell.
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${shell} -l`;
    proc = spawn("script", ["-qfc", inner, "/dev/null"], { cwd, env });
  }
  const resize = (c, r) => {
    // No master-fd ioctl available without a native pty module, so re-apply the
    // size with stty. Ctrl-U first clears any half-typed input line.
    try {
      proc.stdin.write(`\x15stty rows ${r} cols ${c} 2>/dev/null\n`);
    } catch {}
  };
  return { proc, resize };
}

function setupPtyProxy(server, token, defaultCwd) {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/pty-ws") return;

    const qToken = url.searchParams.get("token");
    const hAuth = req.headers["authorization"] || "";
    const hBearer = hAuth.startsWith("Bearer ") ? hAuth.slice(7) : "";
    if (token && qToken !== token && hBearer !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const acceptKey = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      "\r\n"
    );

    const cols = Math.max(2, parseInt(url.searchParams.get("cols"), 10) || 80);
    const rows = Math.max(2, parseInt(url.searchParams.get("rows"), 10) || 24);
    let cwd = url.searchParams.get("cwd") || defaultCwd;
    try { if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = defaultCwd; } catch { cwd = defaultCwd; }

    let pty;
    try {
      pty = spawnPtyShell(cols, rows, cwd);
    } catch (e) {
      try { socket.write(wsFrame(Buffer.from(`\r\n无法启动终端: ${e.message}\r\n`), 0x02)); } catch {}
      socket.destroy();
      return;
    }
    const { proc, resize } = pty;

    const send = (data) => { try { socket.write(wsFrame(data, 0x02)); } catch {} };
    proc.stdout.on("data", send);
    if (proc.stderr) proc.stderr.on("data", send);
    proc.on("exit", (code) => {
      try {
        socket.write(wsFrame(Buffer.from(`\r\n\x1b[90m[shell exited: ${code}]\x1b[0m\r\n`), 0x02));
        socket.write(wsFrame(Buffer.alloc(0), 0x08)); // close
      } catch {}
      socket.end();
    });

    const read = makeWsReader((opcode, payload) => {
      if (opcode === 0x08) { // close
        try { proc.kill(); } catch {}
        socket.end();
      } else if (opcode === 0x09) { // ping → pong
        try { socket.write(wsFrame(payload, 0x0a)); } catch {}
      } else if (opcode === 0x01) { // text → control JSON
        try {
          const msg = JSON.parse(payload.toString("utf8"));
          if (msg && msg.type === "resize") resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0));
        } catch {}
      } else if (opcode === 0x02 || opcode === 0x00) { // binary → stdin
        try { proc.stdin.write(payload); } catch {}
      }
    });

    socket.on("data", read);
    const cleanup = () => { try { proc.kill(); } catch {} };
    socket.on("error", cleanup);
    socket.on("close", cleanup);
  });
}

// ── CDP remote browser proxy ──────────────────────────────────────────────
// Launches a real Chrome/Edge/Chromium on THIS host with --remote-debugging-port
// and transparently proxies its DevTools (CDP) WebSocket to the client. The
// frontend drives it with Page.startScreencast (live frames) + Input.dispatch*
// (mouse/keyboard) + Page.navigate, giving a real interactive browser pane —
// like the local browser, except the browser actually runs on the remote dev
// host (with its own cookies/profile). The agent only bridges WebSocket frames;
// all CDP logic lives in the frontend.

const cdpState = { proc: null, port: 0, starting: null };

// A real CDP-capable browser must be an actual executable, not a wrapper
// script. Some environments (e.g. Devin VMs) put a shell shim named
// `google-chrome` on PATH that just forwards a URL to a host browser — it has
// no `--remote-debugging-port`, so launching it leaves CDP forever unreachable.
// Reject anything whose first bytes are a shebang/script; on Linux a genuine
// Chrome/Chromium binary is an ELF image (`\x7fELF`).
function isLaunchableBrowser(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 4096) return false;
  } catch { return false; }
  if (isWin) return true; // .exe; no reliable cheap magic check needed
  try {
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x23 && buf[1] === 0x21) return false; // "#!" shebang → script shim
    if (process.platform === "linux") {
      // ELF magic 0x7f 'E' 'L' 'F'
      return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    }
  } catch { return false; }
  return true; // macOS Mach-O etc.
}

function findChromeBinary() {
  const { spawnSync } = require("child_process");
  const override = process.env.CDP_BROWSER || process.env.CHROME_PATH;
  if (override && override.trim()) {
    const o = override.trim();
    try { if (fs.existsSync(o) && isLaunchableBrowser(o)) return o; } catch {}
  }
  if (isWin) {
    const candidates = [];
    // 1. Registry App Paths — the authoritative record of where each browser
    //    installed itself (covers per-user installs, custom dirs, all channels).
    const regRoots = ["HKLM", "HKCU"];
    const regBranches = ["SOFTWARE", "SOFTWARE\\WOW6432Node"];
    const regExes = ["chrome.exe", "msedge.exe", "brave.exe"];
    for (const root of regRoots) {
      for (const branch of regBranches) {
        for (const exe of regExes) {
          const key = `${root}\\${branch}\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
          try {
            const r = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", timeout: 4000, windowsHide: true });
            if (r.status === 0 && r.stdout) {
              const m = r.stdout.match(/REG_SZ\s+(.+?\.exe)/i);
              if (m && m[1]) candidates.push(m[1].trim().replace(/^"|"$/g, ""));
            }
          } catch {}
        }
      }
    }
    // 2. Common install locations — system-wide AND per-user (Chrome's default
    //    non-admin install goes to %LOCALAPPDATA%, not Program Files).
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const lad = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    const rels = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Google\\Chrome Beta\\Application\\chrome.exe",
      "Google\\Chrome Dev\\Application\\chrome.exe",
      "Google\\Chrome SxS\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "Chromium\\Application\\chrome.exe",
    ];
    for (const base of [pf, pf86, lad]) {
      for (const rel of rels) candidates.push(path.join(base, rel));
    }
    // 3. PATH lookup as a last resort.
    for (const exe of regExes) {
      try {
        const r = spawnSync("where", [exe], { encoding: "utf8", timeout: 4000, windowsHide: true });
        if (r.status === 0 && r.stdout) {
          for (const line of r.stdout.split(/\r?\n/)) { const p = line.trim(); if (p) candidates.push(p); }
        }
      } catch {}
    }
    for (const c of candidates) {
      try { if (c && fs.existsSync(c) && isLaunchableBrowser(c)) return c; } catch {}
    }
    return null;
  }
  const names = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "microsoft-edge", "microsoft-edge-stable", "brave-browser",
  ];
  for (const n of names) {
    try {
      const r = spawnSync("which", ["-a", n], { encoding: "utf8", timeout: 4000 });
      if (r.status === 0 && r.stdout) {
        for (const line of r.stdout.split("\n")) {
          const c = line.trim();
          // Resolve symlinks so a `which` hit pointing at a shim is rejected
          // by its real target, not the friendly name on PATH.
          let real = c;
          try { real = fs.realpathSync(c); } catch {}
          if (c && isLaunchableBrowser(real)) return real;
        }
      }
    } catch {}
  }
  // Chrome-for-Testing / manually-extracted installs that aren't on PATH.
  const home = os.homedir();
  const linuxFallbacks = [
    "/opt/google/chrome/chrome",
    "/opt/.devin/chrome",
    "/usr/lib/chromium/chromium",
    "/usr/lib/chromium-browser/chromium-browser",
    path.join(home, ".local/opt/chrome-linux64/chrome"),
    path.join(home, ".cache/puppeteer"),
    path.join(home, ".cache/ms-playwright"),
  ];
  for (const c of linuxFallbacks) {
    try {
      const found = resolveBrowserUnder(c);
      if (found) return found;
    } catch {}
  }
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of mac) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// Accept either a direct binary path or a cache root (Puppeteer/Playwright)
// to search shallowly for a chrome/chromium executable.
function resolveBrowserUnder(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (st.isFile()) return isLaunchableBrowser(p) ? p : null;
  if (!st.isDirectory()) return null;
  const stack = [{ dir: p, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && (e.name === "chrome" || e.name === "chromium" || e.name === "chrome-headless-shell")) {
        if (isLaunchableBrowser(full)) return full;
      } else if (e.isDirectory() && depth < 5) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

function cdpHttpGetJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 2000 }, (res) => {
      const cs = [];
      res.on("data", (d) => cs.push(d));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(cs).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function ensureCdpBrowser(log) {
  if (cdpState.proc && cdpState.proc.exitCode === null) return cdpState.port;
  if (cdpState.starting) return cdpState.starting;
  cdpState.starting = (async () => {
    // Reuse an already-healthy DevTools endpoint if one is running (e.g. a
    // browser we launched earlier that outlived an agent restart). Launching a
    // second Chrome against the same user-data-dir hits the singleton lock and
    // never exposes a debug endpoint, so probe the standard range first.
    for (let p = 9222; p < 9222 + 8; p++) {
      try {
        await cdpHttpGetJson(p, "/json/version");
        log(`[cdp] reusing existing DevTools endpoint on port ${p}`);
        cdpState.proc = null;
        cdpState.port = p;
        return p;
      } catch {}
    }
    const bin = findChromeBinary();
    if (!bin) throw new Error("未找到 Chrome/Edge/Chromium，请先在远程主机安装浏览器");
    const port = await findAvailablePort(9222);
    const profile = path.join(os.tmpdir(), "clouddev-cdp-profile");
    try { fs.mkdirSync(profile, { recursive: true }); } catch {}
    const display = isWin ? null : process.env.DISPLAY;
    // Headful when an X display is available (so it also shows up in VNC);
    // otherwise fall back to headless rendering (still supports screencast).
    const headless = !isWin && !display;
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,InfoBars,MediaRouter",
      "--window-size=1280,800",
      "--window-position=0,0",
    ];
    if (!isWin) args.push("--no-sandbox");
    if (headless) args.push("--headless=new", "--disable-gpu", "--hide-scrollbars");
    args.push("about:blank");
    const env = { ...process.env };
    if (display) env.DISPLAY = display;
    log(`[cdp] launching ${bin} (headless=${headless}) on debug port ${port}`);
    const proc = spawn(bin, args, { env, stdio: "ignore", detached: false });
    proc.on("exit", (code) => {
      log(`[cdp] browser exited code=${code}`);
      if (cdpState.proc === proc) { cdpState.proc = null; cdpState.port = 0; }
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await cdpHttpGetJson(port, "/json/version"); ready = true; break; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) { try { proc.kill(); } catch {} throw new Error("Chrome DevTools 端点启动超时"); }
    cdpState.proc = proc;
    cdpState.port = port;
    return port;
  })();
  try { return await cdpState.starting; }
  finally { cdpState.starting = null; }
}

async function getCdpPageWsUrl(port) {
  const list = await cdpHttpGetJson(port, "/json");
  let page = Array.isArray(list)
    ? list.find((t) => t && t.type === "page" && t.webSocketDebuggerUrl)
    : null;
  if (!page) {
    try { page = await cdpHttpGetJson(port, "/json/new?about:blank"); } catch {}
  }
  if (!page || !page.webSocketDebuggerUrl) throw new Error("无可用的浏览器页面目标");
  return page.webSocketDebuggerUrl;
}

// Connect to a WebSocket server as a *client* (to reach Chrome's CDP endpoint).
function wsClientConnect(wsUrl, cb) {
  let u;
  try { u = new URL(wsUrl); } catch (e) { cb(e); return; }
  const key = crypto.randomBytes(16).toString("base64");
  const req = http.request({
    hostname: u.hostname,
    port: u.port || 80,
    path: u.pathname + (u.search || ""),
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    },
  });
  req.on("upgrade", (_res, socket, head) => cb(null, socket, head));
  req.on("error", (e) => cb(e));
  req.end();
}

// Build a *masked* client→server frame (clients MUST mask, per RFC6455).
function wsFrameMasked(data, opcode) {
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

// WS reader that reassembles fragmented messages (CDP frames can be large) and
// surfaces control frames. Delivers each complete message as (opcode, payload).
function makeWsMsgReader(onMessage) {
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragParts = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const m = buf.slice(off, off + 4);
        const o = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) o[i] = payload[i] ^ m[i & 3];
        payload = o;
      }
      buf = buf.slice(off + maskLen + len);
      if (opcode === 0x08 || opcode === 0x09 || opcode === 0x0a) {
        onMessage(opcode, payload); // control frames are never fragmented
        continue;
      }
      if (opcode === 0x00) { fragParts.push(payload); }
      else { fragOpcode = opcode; fragParts = [payload]; }
      if (fin) {
        onMessage(fragOpcode, Buffer.concat(fragParts));
        fragParts = [];
        fragOpcode = 0;
      }
    }
  };
}

function setupCdpProxy(server, token, log) {
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/cdp-ws") return;

    const qToken = url.searchParams.get("token");
    const hAuth = req.headers["authorization"] || "";
    const hBearer = hAuth.startsWith("Bearer ") ? hAuth.slice(7) : "";
    if (token && qToken !== token && hBearer !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const acceptKey = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      "\r\n"
    );

    const sendClient = (data, opcode) => { try { socket.write(wsFrame(data, opcode)); } catch {} };
    let chromeSock = null;
    let closed = false;
    // Buffer client→chrome messages that arrive before the upstream socket is
    // ready (the DevTools connect is async), then flush in order once connected.
    const pending = [];
    const toChrome = (payload, opcode) => {
      if (chromeSock) { try { chromeSock.write(wsFrameMasked(payload, opcode)); } catch {} }
      else pending.push([payload, opcode]);
    };
    const closeAll = () => {
      if (closed) return;
      closed = true;
      try { socket.end(); } catch {}
      try { if (chromeSock) chromeSock.end(); } catch {}
    };

    (async () => {
      try {
        const port = await ensureCdpBrowser(log);
        const wsUrl = await getCdpPageWsUrl(port);
        wsClientConnect(wsUrl, (err, csock, chead) => {
          if (err || closed) {
            sendClient(Buffer.from(JSON.stringify({
              error: "cdp-connect-failed",
              message: String((err && err.message) || err || "closed"),
            })), 0x01);
            closeAll();
            return;
          }
          chromeSock = csock;
          // flush anything the client sent while we were still connecting
          for (const [payload, opcode] of pending.splice(0)) {
            try { chromeSock.write(wsFrameMasked(payload, opcode)); } catch {}
          }
          // chrome → client (re-emit complete messages as unmasked frames)
          const readChrome = makeWsMsgReader((op, payload) => {
            if (op === 0x08) { closeAll(); return; }
            if (op === 0x09) { try { chromeSock.write(wsFrameMasked(payload, 0x0a)); } catch {} return; }
            if (op === 0x0a) return;
            sendClient(payload, op === 0x02 ? 0x02 : 0x01);
          });
          csock.on("data", readChrome);
          csock.on("error", closeAll);
          csock.on("close", closeAll);
          if (chead && chead.length) readChrome(chead);
        });
      } catch (e) {
        sendClient(Buffer.from(JSON.stringify({
          error: "cdp-launch-failed",
          message: String((e && e.message) || e),
        })), 0x01);
        closeAll();
      }
    })();

    // client → chrome (re-mask complete messages for the client role)
    const readClient = makeWsMsgReader((op, payload) => {
      if (op === 0x08) { closeAll(); return; }
      if (op === 0x09) { sendClient(payload, 0x0a); return; }
      if (op === 0x0a) return;
      toChrome(payload, op === 0x02 ? 0x02 : 0x01);
    });
    socket.on("data", readClient);
    socket.on("error", closeAll);
    socket.on("close", closeAll);
  });
}

// ── Server ─────────────────────────────────────────────────────────────────

async function findAvailablePort(base) {
  for (let p = base; p < base + 50; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(p, "0.0.0.0");
    });
    if (free) return p;
  }
  return base;
}

function listenHttpServer(server, port, bindAddr) {
  if (bindAddr !== "0.0.0.0") {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(bindAddr);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, bindAddr);
    });
  }

  return new Promise((resolve, reject) => {
    let fallback = false;
    const onError = (err) => {
      server.removeListener("listening", onListening);
      if (fallback) {
        reject(err);
        return;
      }
      fallback = true;
      server.once("error", reject);
      server.once("listening", () => {
        server.removeListener("error", reject);
        resolve("0.0.0.0");
      });
      server.listen(port, "0.0.0.0");
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve("::");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "::");
  });
}

async function startServer(host, opts) {
  const port = await findAvailablePort(opts.port);
  const token = opts.token;
  const bindAddr = opts.bind || "0.0.0.0";
  const ideCookieName = "rvm_ide_tkn";

  function getCookie(req, name) {
    const header = req.headers && req.headers.cookie;
    if (!header) return "";
    for (const part of String(header).split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      if (part.slice(0, separator).trim() !== name) continue;
      try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ""; }
    }
    return "";
  }

  function getIdeQueryToken(url) {
    return url.searchParams.get("tkn") || url.searchParams.get("token") || "";
  }

  function tokensMatch(candidate) {
    if (!token) return false;
    // Compare fixed-length SHA-256 digests so neither the outcome nor the
    // candidate length is observable via timing.
    const expectedDigest = crypto.createHash("sha256").update(String(token)).digest();
    const candidateDigest = crypto.createHash("sha256").update(String(candidate || "")).digest();
    return crypto.timingSafeEqual(expectedDigest, candidateDigest);
  }

  function isSecureRequest(req) {
    const forwardedProto = req.headers["x-forwarded-proto"] || req.headers["x-original-proto"];
    if (forwardedProto) return String(forwardedProto).split(",")[0].trim().toLowerCase() === "https";
    return Boolean(req.socket && req.socket.encrypted);
  }

  function authorizeIdeRequest(req, url) {
    if (!token) return { ok: true, queryToken: "" };
    const queryToken = getIdeQueryToken(url);
    const cookieToken = getCookie(req, ideCookieName);
    const authorization = String(req.headers.authorization || "");
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    return {
      ok: tokensMatch(queryToken) || tokensMatch(cookieToken) || tokensMatch(bearerToken),
      queryTokenValid: tokensMatch(queryToken),
      queryToken,
    };
  }

  function setIdeCookie(res, req) {
    const cookieAttrs = isSecureRequest(req)
      ? "; SameSite=None; Secure; Partitioned"
      : "; SameSite=Lax";
    const encodedToken = encodeURIComponent(token);
    res.setHeader("Set-Cookie", [
      `${ideCookieName}=${encodedToken}; Path=/; HttpOnly${cookieAttrs}`,
      `vscode-tkn=${encodedToken}; Path=/; HttpOnly${cookieAttrs}`,
    ]);
  }

  function rejectIdeUpgrade(socket) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 12\r\n\r\nunauthorized",
    );
    socket.destroy();
  }

  function addIdeConnectionToken(requestUrl) {
    if (!token) return requestUrl;
    const target = new URL(requestUrl || "/", "http://localhost");
    target.searchParams.set("tkn", token);
    return `${target.pathname}${target.search}`;
  }

  function stripIdeQueryToken(url) {
    const cleanUrl = new URL(url.toString());
    cleanUrl.searchParams.delete("tkn");
    cleanUrl.searchParams.delete("token");
    return `${cleanUrl.pathname}${cleanUrl.search}`;
  }

  function hasParentPathSegment(pathname) {
    try {
      // Fully decode (defends against multi-encoded %252e%252e) before checking.
      let decoded = String(pathname);
      for (let i = 0; i < 5; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      return decoded.split(/[\\/]/).some((segment) => segment === "..");
    } catch {
      return true;
    }
  }

  // Lazy-load optional modules (only present in RVM, not base remote-agent)
  let codeServer = null;
  let novnc = null;
  try { codeServer = require("./code-server.js"); } catch {}
  try { novnc = require("./novnc.js"); } catch {}

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Org-Id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    // ── noVNC static files (unauthenticated for browser access) ──────
    if (novnc && pathname.startsWith("/novnc")) {
      novnc.serveNoVncFile(req, res);
      return;
    }

    // ── Web IDE assets requested at the origin root ──────────────────
    // The Devin serve-web workbench references its assets at the ORIGIN ROOT
    // (/out/*, /resources/*, /extensions/*, /node_modules/* [xterm terminal
    // renderer], and the remote-resource endpoint)
    // via window.location.origin, ignoring the /ide server-base-path. serve-web
    // actually serves them under /ide/static/* (and /ide/vscode-remote-resource).
    // Bridge the two without an agent-level gate. The proxy adds the serve-web
    // connection token internally while the browser-facing document is gated.
    if (codeServer && codeServer.isRunning()) {
      if (/^\/(out|resources|extensions|node_modules)\//.test(pathname)) {
        if (hasParentPathSegment(pathname)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        req.url = addIdeConnectionToken("/ide/static" + req.url);
        codeServer.proxyRequest(req, res, "/ide", token);
        return;
      }
      if (pathname === "/vscode-remote-resource" || pathname.startsWith("/vscode-remote-resource/")) {
        if (!authorizeIdeRequest(req, url).ok) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        req.url = addIdeConnectionToken("/ide" + req.url);
        codeServer.proxyRequest(req, res, "/ide", token);
        return;
      }
    }

    // ── code-server reverse proxy (/ide/*) ───────────────────────────
    if (codeServer && pathname.startsWith("/ide")) {
      const isIdeDocument =
        req.method === "GET" &&
        (pathname === "/ide" || pathname === "/ide/") &&
        String(req.headers.accept || "").toLowerCase().includes("text/html");
      if (isIdeDocument) {
        const authorization = authorizeIdeRequest(req, url);
        if (!authorization.ok) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (authorization.queryTokenValid) {
          setIdeCookie(res, req);
          res.writeHead(302, {
            Location: stripIdeQueryToken(url),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
      }
      codeServer.proxyRequest(req, res, "/ide", token);
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsedBody = {};
      try { parsedBody = raw ? JSON.parse(raw) : {}; } catch { parsedBody = {}; }
      try {
        // Try core routes first
        const out = await handleRoute(host, pathname, req.method || "GET", req.headers, raw, token);

        // If core returned 404, try extended handler
        if (out.status === 404 && host.extendedHandler) {
          // Auth check for extended routes
          if (!checkAuth(req.headers, token)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }

          const extOut = await host.extendedHandler(pathname, req.method || "GET", req.headers, parsedBody, token);
          if (extOut) {
            if (host.recordRoute) {
              try { await host.recordRoute(pathname, req.method || "GET", parsedBody, extOut); } catch { /* logging is best effort */ }
            }
            if (extOut.raw !== undefined) {
              res.writeHead(extOut.status, { "Content-Type": extOut.contentType || "text/plain; charset=utf-8" });
              res.end(extOut.raw);
            } else {
              res.writeHead(extOut.status, { "Content-Type": "application/json" });
              res.end(JSON.stringify(extOut.body, null, 2));
            }
            return;
          }
        }

        if (host.recordRoute && out.status !== 404) {
          try { await host.recordRoute(pathname, req.method || "GET", parsedBody, out); } catch { /* logging is best effort */ }
        }
        if (out.raw !== undefined) {
          res.writeHead(out.status, { "Content-Type": out.contentType || "text/plain; charset=utf-8" });
          res.end(out.raw);
        } else {
          res.writeHead(out.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out.body, null, 2));
        }
      } catch (e) {
        if (host.recordRoute) {
          try {
            await host.recordRoute(
              pathname,
              req.method || "GET",
              parsedBody,
              { status: 500, body: { error: String((e && e.message) || e) } },
            );
          } catch { /* logging is best effort */ }
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  });

  // Set up VNC WebSocket proxy
  if (opts.vncPort) {
    setupVncProxy(server, opts.vncPort, token, opts.vncHost);
  }
  // Set up interactive PTY WebSocket (real terminal)
  setupPtyProxy(server, token, host.workspaceRoot());
  // Set up CDP remote browser WebSocket (real interactive Chrome/Edge)
  setupCdpProxy(server, token, host.log);

  // Set up code-server WebSocket proxy (/ide/ WebSocket upgrade)
  if (codeServer) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname.startsWith("/ide")) {
        codeServer.proxyWebSocket(req, socket, head);
      } else if (
        codeServer.isRunning() &&
        url.searchParams.has("reconnectionToken") &&
        !url.pathname.startsWith("/vnc-ws") &&
        !url.pathname.startsWith("/pty-ws") &&
        !url.pathname.startsWith("/cdp-ws")
      ) {
        if (!authorizeIdeRequest(req, url).ok) {
          rejectIdeUpgrade(socket);
          return;
        }
        // The Devin serve-web workbench opens its remote-server management
        // socket at the origin root (/?reconnectionToken=…), ignoring the /ide
        // base path. Forward it to serve-web's /ide endpoint so the IDE's file
        // system / terminal / extension host connect.
        req.url = "/ide" + (req.url || "/");
        codeServer.proxyWebSocket(req, socket, head);
      }
    });
  }

  const listenAddr = await listenHttpServer(server, port, bindAddr);
  const displayAddr = listenAddr === "::" ? "[::]" : listenAddr;
  host.log(`dev-agent server on http://${displayAddr}:${port}`);
  return { port, token, server, close: () => server.close() };
}

module.exports = {
  checkAuth,
  handleRoute,
  handleComputerUse,
  setupVncProxy,
  setupPtyProxy,
  setupCdpProxy,
  findAvailablePort,
  startServer,
  runShell,
  findChromeBinary,
};

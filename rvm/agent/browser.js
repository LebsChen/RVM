"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const state = { proc: null, port: 0, profile: null, ws: null, target: null, starting: null };

function isLaunchableBrowser(candidate) {
  let real;
  try {
    real = fs.realpathSync(candidate);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size < 4096) return false;
    const fd = fs.openSync(real, "r");
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (magic.toString("ascii", 0, 2) === "#!") return false;
    return process.platform !== "linux" || (magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46);
  } catch {
    return false;
  }
}

function findBrowser() {
  try {
    const core = require("./core.js");
    const detected = core.findChromeBinary();
    if (detected && isLaunchableBrowser(detected)) return fs.realpathSync(detected);
  } catch {}
  const names = process.platform === "win32"
    ? [
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    ]
    : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
  for (const name of names) {
    if (path.isAbsolute(name)) {
      try { if (fs.statSync(name).isFile()) return name; } catch {}
      continue;
    }
    for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, name);
      if (isLaunchableBrowser(candidate)) return fs.realpathSync(candidate);
    }
  }
  const fallback = [
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/lib/chromium/chromium",
  ];
  try {
    const root = "/opt/.devin/chrome";
    for (const family of fs.readdirSync(root)) {
      for (const version of fs.readdirSync(path.join(root, family))) {
        const candidate = path.join(root, family, version, "chrome-linux64", "chrome");
        if (isLaunchableBrowser(candidate)) return fs.realpathSync(candidate);
      }
    }
  } catch {}
  for (const candidate of fallback) {
    if (isLaunchableBrowser(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error("Chrome, Chromium, Edge, or Brave browser executable not found");
}

function httpJson(port, pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`DevTools HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function wsFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function connectWebSocket(wsUrl) {
  const target = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      },
    });
    req.once("upgrade", (_response, socket, head) => {
      const client = {
        socket,
        buffer: Buffer.concat([head || Buffer.alloc(0)]),
        nextId: 1,
        pending: new Map(),
        fragments: [],
        fragmentOpcode: 0,
      };
      const fail = (err) => {
        for (const pending of client.pending.values()) pending.reject(err);
        client.pending.clear();
      };
      const read = () => {
        for (;;) {
          if (client.buffer.length < 2) return;
          const first = client.buffer[0];
          const second = client.buffer[1];
          const fin = (first & 0x80) !== 0;
          const opcode = first & 0x0f;
          let length = second & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (client.buffer.length < 4) return;
            length = client.buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (client.buffer.length < 10) return;
            length = Number(client.buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (client.buffer.length < offset + length) return;
          const payload = client.buffer.slice(offset, offset + length);
          client.buffer = client.buffer.slice(offset + length);
          if (opcode === 0x09) { socket.write(wsFrame(payload, 0x0a)); continue; }
          if (opcode === 0x08) { socket.end(); fail(new Error("CDP WebSocket closed")); return; }
          if (opcode === 0x00 || opcode === 0x01 || opcode === 0x02) {
            if (opcode !== 0x00) {
              client.fragments = [payload];
              client.fragmentOpcode = opcode;
            } else {
              client.fragments.push(payload);
            }
            if (!fin) continue;
            const message = Buffer.concat(client.fragments);
            const messageOpcode = client.fragmentOpcode;
            client.fragments = [];
            client.fragmentOpcode = 0;
            if (messageOpcode === 0x01) {
              let value;
              try { value = JSON.parse(message.toString("utf8")); } catch { continue; }
              if (value.id !== undefined && client.pending.has(value.id)) {
                const pending = client.pending.get(value.id);
                client.pending.delete(value.id);
                if (value.error) pending.reject(new Error(value.error.message || "CDP error"));
                else pending.resolve(value.result);
              }
            }
          }
        }
      };
      socket.on("data", (chunk) => { client.buffer = Buffer.concat([client.buffer, chunk]); read(); });
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("CDP WebSocket closed")));
      client.call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
        const id = client.nextId++;
        client.pending.set(id, { resolve: resolveCall, reject: rejectCall });
        socket.write(wsFrame(JSON.stringify({ id, method, params })));
      });
      client.close = () => { try { socket.end(); } catch {} };
      resolve(client);
    });
    req.once("error", reject);
    req.end();
  });
}

async function waitForTarget(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await httpJson(port, "/json");
      const target = Array.isArray(targets) && targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browser DevTools page target did not become ready");
}

async function ensureBrowser() {
  if (state.ws && state.proc && !state.proc.killed) return state;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const browser = findBrowser();
    state.profile = fs.mkdtempSync(path.join(os.tmpdir(), "rvm-browser-"));
    state.proc = spawn(browser, [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${state.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    state.proc.on("exit", () => { if (state.proc && state.proc.exitCode !== null) state.ws = null; });
    let port = 0;
    for (let i = 0; i < 60; i++) {
      try {
        const active = fs.readFileSync(path.join(state.profile, "DevToolsActivePort"), "utf8").trim().split(/\s+/);
        port = Number(active[0]);
        if (port) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new Error("browser DevTools port did not become ready");
    state.port = port;
    state.target = await waitForTarget(port);
    state.ws = await connectWebSocket(state.target.webSocketDebuggerUrl);
    return state;
  })();
  try { return await state.starting; }
  finally { state.starting = null; }
}

async function navigate(url) {
  const browser = await ensureBrowser();
  const result = await browser.ws.call("Page.navigate", { url: String(url) });
  return { url: String(url), result };
}

async function evaluate(expression) {
  const browser = await ensureBrowser();
  const result = await browser.ws.call("Runtime.evaluate", { expression: String(expression), returnByValue: true, awaitPromise: true });
  return result;
}

async function screenshot() {
  const browser = await ensureBrowser();
  const result = await browser.ws.call("Page.captureScreenshot", { format: "png" });
  return result.data;
}

async function close() {
  if (state.ws) state.ws.close();
  if (state.proc) {
    try { state.proc.kill(); } catch {}
  }
  if (state.profile) {
    try { fs.rmSync(state.profile, { recursive: true, force: true }); } catch {}
  }
  state.proc = null;
  state.port = 0;
  state.profile = null;
  state.ws = null;
  state.target = null;
}

module.exports = { navigate, evaluate, screenshot, close, findBrowser };

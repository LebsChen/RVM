"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const isWin = process.platform === "win32";

function splitCommandLine(spec) {
  const out = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  for (const ch of String(spec || "").trim()) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (quote === "\"") {
        escaped = true;
        continue;
      }
      cur += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseCommandSpec(spec, fallbackArgs = []) {
  if (Array.isArray(spec)) {
    const [command, ...args] = spec;
    return { command, args };
  }
  const parts = splitCommandLine(spec);
  if (!parts.length) {
    return { command: "", args: [...fallbackArgs] };
  }
  return { command: parts[0], args: [...parts.slice(1), ...fallbackArgs] };
}

function getPathExts() {
  if (!isWin) return [""];
  const envExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...envExt, ""];
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (isWin) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableOnPath(command) {
  if (!command) return null;
  const hasSlash = /[\\/]/.test(command);
  const candidates = [];
  if (hasSlash) {
    if (isWin && !path.extname(command)) {
      for (const ext of getPathExts()) {
        candidates.push(command + ext);
      }
    } else {
      candidates.push(command);
    }
  } else {
    const pathValue = process.env.PATH || "";
    const dirs = pathValue.split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      if (isWin) {
        for (const ext of getPathExts()) candidates.push(path.join(dir, command + ext));
      } else {
        candidates.push(path.join(dir, command));
      }
    }
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function quoteWindowsShellArg(value) {
  const text = String(value);
  if (!text) return "\"\"";
  if (!/[\s\\"&|<>^()]/.test(text)) return text;
  return `"${text
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")}"`;
}

function formatInstallHint(command, installHint) {
  const lines = [
    `找不到可执行文件: ${command}`,
    `请先安装对应语言服务器/调试适配器，或通过环境变量覆盖。`,
  ];
  if (installHint) lines.push(`建议: ${installHint}`);
  return lines.join(" ");
}

class StdioRpcClient {
  constructor(spec, opts = {}) {
    const { command, args } = parseCommandSpec(spec, opts.extraArgs || []);
    this.command = command;
    this.args = args;
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env || process.env;
    this.name = opts.name || command || "stdio-rpc";
    this.onNotification = opts.onNotification || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.onStderr = opts.onStderr || (() => {});
    this.seq = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.proc = null;
    this.spawn();
  }

  spawn() {
    if (!this.command) {
      throw new Error(`未配置 ${this.name} 命令`);
    }
    const isWindowsScript = isWin && /\.(?:cmd|bat)$/i.test(this.command);
    const spawnCommand = isWindowsScript ? quoteWindowsShellArg(this.command) : this.command;
    const spawnArgs = isWindowsScript ? this.args.map(quoteWindowsShellArg) : this.args;
    this.proc = spawn(spawnCommand, spawnArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindowsScript,
      windowsHide: true,
    });
    this.proc.on("error", (err) => {
      this.failAll(err);
      this.onExit(err);
    });
    this.proc.on("exit", (code, signal) => {
      const err = new Error(`${this.name} 进程退出: code=${code} signal=${signal}`);
      this.failAll(err);
      this.onExit(err);
    });
    if (this.proc.stdout) this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    if (this.proc.stderr) {
      this.proc.stderr.on("data", (chunk) => this.onStderr(chunk.toString("utf8")));
    }
  }

  failAll(err) {
    if (this.closed) return;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.closed = true;
  }

  close() {
    this.closed = true;
    try { this.proc?.kill(); } catch {}
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.proc || this.closed) return Promise.reject(new Error(`${this.name} 未运行`));
    const id = this.seq++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params === undefined ? undefined : params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.proc.stdin.write(frame, "utf8");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (!this.proc || this.closed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params === undefined ? undefined : params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    try {
      this.proc.stdin.write(frame, "utf8");
    } catch {}
  }

  onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const body = this.buffer.slice(bodyStart, bodyStart + len).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || `${this.name} RPC error`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      this.onNotification(msg.method, msg.params);
    }
  }
}

module.exports = {
  StdioRpcClient,
  parseCommandSpec,
  resolveExecutableOnPath,
  formatInstallHint,
  splitCommandLine,
};

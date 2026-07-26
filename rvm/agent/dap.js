"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { parseCommandSpec, resolveExecutableOnPath, formatInstallHint } = require("./stdio-rpc.js");

const SESSION_IDLE_MS = 120000;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeLanguage(language) {
  const v = String(language || "").toLowerCase();
  if (v.includes("python") || v === "py") return "python";
  if (v.includes("go")) return "go";
  if (v.includes("rust")) return "rust";
  if (v.includes("c++") || v.includes("cpp") || v === "c" || v.includes("clang")) return "cpp";
  if (v.includes("node") || v.includes("js") || v.includes("typescript") || v.includes("javascript")) return "node";
  return v || "node";
}

function sessionKey(language, workspaceRoot) {
  return `${normalizeLanguage(language || "node")}:${path.resolve(workspaceRoot || process.cwd())}`;
}

function buildRegistry() {
  return {
    python: {
      env: ["RVM_DAP_PYTHON"],
      specs: [["python3", ["-m", "debugpy.adapter"]], ["python", ["-m", "debugpy.adapter"]], ["py", ["-3", "-m", "debugpy.adapter"]]],
      install: "python -m pip install --user debugpy",
    },
    go: {
      env: ["RVM_DAP_GO"],
      specs: [["dlv", ["dap"]]],
      install: "go install github.com/go-delve/delve/cmd/dlv@latest",
    },
    cpp: {
      env: ["RVM_DAP_CPP", "RVM_DAP_RUST"],
      specs: [["lldb-dap", []], ["codelldb", []]],
      install: "install lldb-dap or codelldb (e.g. apt install lldb / brew install llvm)",
    },
    rust: {
      env: ["RVM_DAP_RUST", "RVM_DAP_CPP"],
      specs: [["lldb-dap", []], ["codelldb", []]],
      install: "install lldb-dap or codelldb (e.g. apt install lldb / brew install llvm)",
    },
    node: {
      env: ["RVM_DAP_NODE", "RVM_DAP_JS"],
      specs: [["js-debug", []], ["js-debug-adapter", []]],
      install: "install the VS Code js-debug adapter (or point RVM_DAP_NODE at it)",
    },
  };
}

function parseTcpSpec(spec) {
  const text = String(spec || "");
  if (!text.toLowerCase().startsWith("tcp:")) return null;
  const value = text.slice(4);
  const match = value.match(/^\[([^\]]+)\]:(\d+)$/) || value.match(/^([^:]+):(\d+)$/);
  if (!match) throw new Error(`无效 TCP DAP spec: ${text}`);
  return { transport: "tcp", host: match[1], port: Number(match[2]) };
}

function findJsDebugScript() {
  const candidates = [];
  for (const envKey of ["RVM_DAP_NODE", "RVM_DAP_JS"]) {
    const value = (process.env[envKey] || "").trim();
    if (!value) continue;
    const tcp = parseTcpSpec(value);
    if (tcp) return { ...tcp, source: `env:${envKey}` };
    if (fs.existsSync(value)) {
      return { transport: "tcp", command: process.execPath, args: [value], launch: true, source: `env:${envKey}` };
    }
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "js-debug", "src", "dapDebugServer.js"));
  const home = os.homedir();
  candidates.push(
    path.join(home, ".js-debug", "src", "dapDebugServer.js"),
    path.join(home, ".vscode", "extensions", "ms-vscode.js-debug", "src", "dapDebugServer.js"),
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { transport: "tcp", command: process.execPath, args: [candidate], launch: true, source: "path" };
    }
  }
  return null;
}

function findWindowsPythonCandidates() {
  if (process.platform !== "win32") return [];
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python"));
  if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "Python"));
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      const exe = path.join(root, entry, "python.exe");
      if (/^python3/i.test(entry) && fs.existsSync(exe)) found.push(exe);
    }
  }
  return found;
}

function probeDebugpy(pythonExe) {
  const probe = spawnSync(pythonExe, ["-c", "import debugpy,sys; sys.exit(0)"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return probe.status === 0;
}

function findAdapterSpec(language) {
  const key = normalizeLanguage(language);
  const registry = buildRegistry();
  const entry = registry[key] || registry.node;
  for (const envKey of entry.env) {
    const val = (process.env[envKey] || "").trim();
    if (!val) continue;
    const tcp = parseTcpSpec(val);
    if (tcp) return { ...tcp, source: `env:${envKey}`, install: entry.install };
    if (key === "node" && fs.existsSync(val)) {
      return { transport: "tcp", command: process.execPath, args: [val], launch: true, source: `env:${envKey}`, install: entry.install };
    }
    const { command, args } = parseCommandSpec(val);
    if (command) return { command, args, source: `env:${envKey}`, install: entry.install };
  }
  if (key === "node") {
    const script = findJsDebugScript();
    if (script) return { ...script, install: entry.install };
  }
  for (const [command, args] of entry.specs) {
    const resolved = resolveExecutableOnPath(command);
    if (!resolved) continue;
    if (key === "python") {
      const usesDebugpy = args.some((a) => String(a).includes("debugpy.adapter"));
      if (usesDebugpy && !probeDebugpy(resolved)) continue;
    }
    return { command: resolved, args, source: "path", install: entry.install };
  }
  if (key === "python") {
    for (const exe of findWindowsPythonCandidates()) {
      if (probeDebugpy(exe)) {
        return { command: exe, args: ["-m", "debugpy.adapter"], source: "discovered", install: entry.install };
      }
    }
  }
  const first = entry.specs[0];
  const hint = formatInstallHint(first ? first[0] : key, entry.install);
  const err = new Error(hint);
  err.language = key;
  throw err;
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeLogger(logger) {
  return typeof logger === "function" ? logger : () => {};
}

function findFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once("connect", () => {
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", fail);
  });
}

async function connectTcpWithRetry(host, port) {
  let lastError;
  for (let i = 0; i < 60; i++) {
    try { return await connectTcp(host, port); } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error(`无法连接 DAP TCP ${host}:${port}`);
}

class DapRpcClient {
  constructor(spec, opts = {}) {
    const parsed = spec && typeof spec === "object" && !Array.isArray(spec)
      ? spec
      : (parseTcpSpec(spec) || parseCommandSpec(spec, opts.extraArgs || []));
    this.transport = opts.transport || parsed.transport || "stdio";
    this.command = parsed.command;
    this.args = parsed.args || [];
    this.tcpHost = parsed.host || opts.host || "127.0.0.1";
    this.tcpPort = parsed.port || opts.port || 0;
    this.launchTcp = parsed.launch === true || opts.launch === true;
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env || process.env;
    this.name = opts.name || command || "dap";
    this.onEvent = opts.onEvent || (() => {});
    this.onReverseRequest = opts.onReverseRequest || null;
    this.onStderr = opts.onStderr || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.seq = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.proc = null;
    this.socket = null;
    this.stream = null;
    this.ready = this.spawn();
  }

  spawn() {
    if (this.transport === "tcp") return this.spawnTcp();
    if (!this.command) throw new Error(`未配置 ${this.name} 命令`);
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
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
    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk) => this.onStderr(chunk.toString("utf8")));
    this.stream = this.proc.stdin;
    return Promise.resolve();
  }

  async spawnTcp() {
    if (this.launchTcp) {
      if (!this.command) throw new Error(`未配置 ${this.name} 命令`);
      if (!this.tcpPort) this.tcpPort = await findFreePort(this.tcpHost);
      this.proc = spawn(this.command, [...this.args, String(this.tcpPort), this.tcpHost], {
        cwd: this.cwd,
        env: this.env,
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
        windowsHide: true,
      });
      this.proc.on("error", (err) => {
        this.failAll(err);
        this.onExit(err);
      });
      this.proc.on("exit", (code, signal) => {
        if (!this.closed) {
          const err = new Error(`${this.name} 进程退出: code=${code} signal=${signal}`);
          this.failAll(err);
          this.onExit(err);
        }
      });
      this.proc.stderr.on("data", (chunk) => this.onStderr(chunk.toString("utf8")));
    }
    this.socket = await connectTcpWithRetry(this.tcpHost, this.tcpPort);
    this.stream = this.socket;
    this.socket.on("data", (chunk) => this.onStdout(chunk));
    this.socket.on("error", (err) => {
      this.failAll(err);
      this.onExit(err);
    });
    this.socket.on("close", () => {
      if (!this.closed) this.onExit(new Error(`${this.name} TCP connection closed`));
    });
    return this;
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
    try { this.socket?.destroy(); } catch {}
    try { this.proc?.kill(); } catch {}
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
  }

  request(command, args, timeoutMs = 30000) {
    if (this.closed || !this.stream) return Promise.reject(new Error(`${this.name} 未运行`));
    const seq = this.seq++;
    const msg = { seq, type: "request", command };
    if (args !== undefined) msg.arguments = args;
    const payload = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`${this.name} 请求超时: ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer, command });
      try {
        this.stream.write(frame, "utf8");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(err);
      }
    });
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

  sendResponse(request, body) {
    const msg = {
      seq: this.seq++,
      type: "response",
      request_seq: request.seq,
      success: true,
      command: request.command,
    };
    if (body !== undefined) msg.body = body;
    const payload = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    try { this.stream.write(frame, "utf8"); } catch {}
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "request") {
      try {
        if (this.onReverseRequest) this.onReverseRequest(msg, this);
        else this.sendResponse(msg);
      } catch {}
      return;
    }
    if (msg.type === "response") {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(pending.timer);
      if (msg.success === false) {
        const err = new Error(msg.message || `${this.name} DAP error`);
        err.body = msg.body;
        pending.reject(err);
      } else {
        pending.resolve(msg.body !== undefined ? msg.body : msg);
      }
      return;
    }
    if (msg.type === "event") {
      try { this.onEvent(msg.event, msg.body || {}); } catch {}
    }
  }
}

class DapSession {
  constructor(language, workspaceRoot, logger) {
    this.language = normalizeLanguage(language);
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.logger = normalizeLogger(logger);
    this.id = uuid();
    this.client = null;
    this.children = [];
    this.adapter = null;
    this.initialized = false;
    this.started = false;
    this.everStarted = false;
    this.eventSeq = 0;
    this.events = [];
    this.lastUsed = Date.now();
    this.idleTimer = null;
    this.startPromise = null;
  }

  touch() {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose().catch(() => {}), SESSION_IDLE_MS);
  }

  bufferEvent(kind, params) {
    const event = { seq: ++this.eventSeq, kind, at: new Date().toISOString(), params };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  isDead() {
    return this.everStarted && (!this.started || !this.client || this.client.closed);
  }

  async resetIfDead() {
    if (!this.isDead()) return;
    await this.dispose();
    this.everStarted = false;
  }

  async ensureStarted() {
    if (this.started) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const spec = findAdapterSpec(this.language);
      this.adapter = spec;
      this.client = new DapRpcClient(spec.transport ? spec : [spec.command, ...spec.args], {
        transport: spec.transport,
        host: spec.host,
        port: spec.port,
        launch: spec.launch,
        cwd: process.cwd(),
        env: { ...process.env },
        name: `dap:${this.language}`,
        onEvent: (method, params) => this.handleNotification(method, params),
        onReverseRequest: (msg, from) => this.handleReverseRequest(msg, from),
        onStderr: (text) => this.logger(`[dap:${this.language}] ${text.trim()}`),
        onExit: (err) => {
          this.logger(`[dap:${this.language}] exited: ${String((err && err.message) || err)}`);
          this.started = false;
          this.initialized = false;
        },
      });
      await this.client.ready;
      this.started = true;
      this.everStarted = true;
      this.touch();
      return this;
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async dispose() {
    for (const child of this.children) {
      try { child.client.close(); } catch {}
    }
    this.children = [];
    if (this.client) {
      try { this.client.close(); } catch {}
    }
    this.started = false;
    this.initialized = false;
    this.client = null;
  }

  activeClient() {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const child = this.children[i];
      if (child.client && !child.client.closed) return child.client;
    }
    return this.client;
  }

  handleReverseRequest(msg, client) {
    const target = client || this.client;
    if (target && !target.closed) {
      try { target.sendResponse(msg); } catch {}
    }
    if (msg.command === "startDebugging") {
      this.spawnChild(msg.arguments || {}).catch((err) => {
        this.logger(`[dap:${this.language}] child session failed: ${String((err && err.message) || err)}`);
      });
    }
  }

  async spawnChild(args) {
    if (!this.client || this.client.transport !== "tcp") return;
    const child = { client: null };
    child.client = new DapRpcClient(
      { transport: "tcp", host: this.client.tcpHost, port: this.client.tcpPort },
      {
        transport: "tcp",
        host: this.client.tcpHost,
        port: this.client.tcpPort,
        name: `dap:${this.language}:child`,
        onEvent: (method, params) => {
          if (method === "initialized") {
            child.client.request("configurationDone", {}, 10000).catch(() => {});
          }
          this.handleNotification(method, params);
        },
        onReverseRequest: (msg, from) => this.handleReverseRequest(msg, from),
        onStderr: (text) => this.logger(`[dap:${this.language}:child] ${text.trim()}`),
        onExit: () => {
          this.children = this.children.filter((c) => c !== child);
        },
      },
    );
    await child.client.ready;
    await child.client.request("initialize", {
      clientID: "rvm",
      clientName: "RVM (Remote Virtual Machines)",
      adapterID: this.language,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
    }, 30000);
    this.children.push(child);
    const configuration = args.configuration || {};
    const requestKind = args.request === "attach" ? "attach" : "launch";
    await child.client.request(requestKind, configuration, 60000);
    this.touch();
  }

  handleNotification(method, params) {
    if (method === "output" || method === "stopped" || method === "continued" || method === "terminated" || method === "exited" || method === "thread") {
      this.bufferEvent(method, params || {});
    }
    if (method === "initialized") {
      this.bufferEvent(method, params || {});
      if (this.autoConfigurationDone !== false && this.client && !this.client.closed) {
        this.client.request("configurationDone", {}, 10000).catch(() => {});
      }
    }
  }

  async initialize(args = {}) {
    await this.ensureStarted();
    if (this.initialized) return { session: this.id, adapter: this.adapter, initialized: true };
    const req = {
      clientID: "rvm",
      clientName: "RVM (Remote Virtual Machines)",
      adapterID: args.adapterID || this.language,
      locale: args.locale || "en-US",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: true,
      supportsMemoryReferences: true,
      supportsProgressReporting: true,
      supportsInvalidatedEvent: true,
      supportsMemoryEvent: true,
      ...args.capabilities,
    };
    const res = await this.client.request("initialize", req, args.timeoutMs || 30000);
    this.initialized = true;
    this.touch();
    return { session: this.id, adapter: this.adapter, capabilities: res && res.capabilities ? res.capabilities : res, response: res };
  }

  async ensureInitialized(args = {}) {
    if (!this.initialized) await this.initialize(args);
  }

  async request(method, params, timeoutMs = 30000) {
    if (this.isDead()) {
      throw new Error(`DAP session ${this.id} 已结束（adapter 已退出），请重新 launch/attach`);
    }
    await this.ensureStarted();
    await this.ensureInitialized();
    this.touch();
    const client = this.activeClient();
    if (!client) throw new Error(`DAP session ${this.id} 无可用连接`);
    return client.request(method, params, timeoutMs);
  }

  recentEvents(afterSeq = 0, limit = 50) {
    return this.events.filter((e) => e.seq > afterSeq).slice(-limit);
  }

  // js-debug's DAP server only accepts its own debug types (e.g. "pwa-node")
  // and rejects configs with unknown fields by never answering the request, so
  // map generic node types and strip RVM control fields before sending.
  buildDebugConfig(kind, args) {
    const config = { type: args.type || this.language, ...args, request: kind };
    if (kind === "launch" && !config.cwd) config.cwd = process.cwd();
    for (const key of ["op", "session", "language", "root", "workspaceRoot", "timeoutMs", "capabilities", "launch", "attach"]) delete config[key];
    if (!config.name) config.name = `rvm-${kind}`;
    if (this.language === "node" && (config.type === "node" || config.type === "javascript")) config.type = "pwa-node";
    return config;
  }

  async launch(args = {}) {
    await this.resetIfDead();
    await this.ensureStarted();
    await this.ensureInitialized(args);
    const request = this.buildDebugConfig("launch", args);
    const res = await this.client.request("launch", request, args.timeoutMs || 30000);
    this.touch();
    return { session: this.id, response: res };
  }

  async attach(args = {}) {
    await this.resetIfDead();
    await this.ensureStarted();
    await this.ensureInitialized(args);
    const request = this.buildDebugConfig("attach", args);
    const res = await this.client.request("attach", request, args.timeoutMs || 30000);
    this.touch();
    return { session: this.id, response: res };
  }

  async simple(method, params = {}, timeoutMs = 30000) {
    const res = await this.request(method, params, timeoutMs);
    this.touch();
    return res;
  }
}

const sessionsById = new Map();
const sessionsByWorkspace = new Map();

function registerSession(session) {
  sessionsById.set(session.id, session);
  sessionsByWorkspace.set(sessionKey(session.language, session.workspaceRoot), session);
  return session;
}

function getSession(language, workspaceRoot, createIfMissing = true, logger) {
  const key = sessionKey(language || "node", workspaceRoot);
  let s = sessionsByWorkspace.get(key);
  if (!s && createIfMissing) {
    s = registerSession(new DapSession(language || "node", workspaceRoot, logger));
  }
  return s;
}

function toolSchema() {
  return {
    type: "object",
    additionalProperties: true,
    required: ["op"],
    properties: {
      op: {
        type: "string",
        enum: [
          "initialize",
          "launch",
          "attach",
          "restart",
          "disconnect",
          "terminate",
          "setBreakpoints",
          "setFunctionBreakpoints",
          "setExceptionBreakpoints",
          "setInstructionBreakpoints",
          "setDataBreakpoints",
          "dataBreakpointInfo",
          "configurationDone",
          "continue",
          "next",
          "stepIn",
          "stepOut",
          "pause",
          "stackTrace",
          "scopes",
          "variables",
          "setVariable",
          "evaluate",
          "threads",
          "source",
          "exceptionInfo",
          "readMemory",
          "disassemble",
          "events",
        ],
      },
      session: { type: "string" },
      language: { type: "string" },
      cwd: { type: "string" },
      program: { type: "string" },
      args: { type: "array" },
      env: { type: "object" },
      path: { type: "string" },
      source: { type: "object" },
      breakpoints: { type: "array" },
      filters: { type: "array" },
      filterOptions: { type: "array" },
      exceptionOptions: { type: "array" },
      restartArguments: { type: "object" },
      threadId: { type: "number" },
      frameId: { type: "number" },
      variablesReference: { type: "number" },
      expression: { type: "string" },
      name: { type: "string" },
      value: { type: "string" },
      line: { type: "number" },
      column: { type: "number" },
      sourceReference: { type: "number" },
      memoryReference: { type: "string" },
      count: { type: "number" },
      after: { type: "number" },
      offset: { type: "number" },
      instructionOffset: { type: "number" },
      startFrame: { type: "number" },
      levels: { type: "number" },
      terminateDebuggee: { type: "boolean" },
      restart: { type: "boolean" },
      noDebug: { type: "boolean" },
      stopOnEntry: { type: "boolean" },
      launch: { type: "object" },
      attach: { type: "object" },
      timeoutMs: { type: "number" },
    },
  };
}

async function callTool(workspaceRoot, args = {}, logger) {
  const op = String(args.op || args.action || args.command || args.method || "").trim();
  if (!op) {
    throw new Error("DAP 工具参数缺失 'op' (例如 op: 'initialize' | 'launch' | 'stackTrace' | 'variables')");
  }
  const root = path.resolve(workspaceRoot || args.root || args.workspaceRoot || process.cwd());
  const session = args.session ? sessionsById.get(String(args.session)) : getSession(args.language || args.type || "node", root, true, logger);
  if (args.session && !session) throw new Error(`找不到 DAP session: ${args.session}`);
  if (!session) throw new Error("无法创建 DAP session");
  try {
    let result;
    switch (op) {
      case "initialize":
        registerSession(session);
        result = await session.initialize(args);
        break;
      case "launch":
        registerSession(session);
        result = await session.launch(args);
        break;
      case "attach":
        registerSession(session);
        result = await session.attach(args);
        break;
      case "restart":
        result = await session.simple("restart", args.restartArguments || {}, args.timeoutMs || 30000);
        break;
      case "disconnect":
        result = await session.simple("disconnect", {
          restart: Boolean(args.restart),
          terminateDebuggee: args.terminateDebuggee !== false,
        }, args.timeoutMs || 30000);
        break;
      case "terminate":
        result = await session.simple("terminate", { restart: Boolean(args.restart) }, args.timeoutMs || 30000);
        break;
      case "setBreakpoints":
        result = await session.simple("setBreakpoints", {
          source: args.source || (args.path ? { path: path.resolve(String(args.path)) } : undefined),
          breakpoints: safeArray(args.breakpoints),
          sourceModified: Boolean(args.sourceModified),
        }, args.timeoutMs || 30000);
        break;
      case "setFunctionBreakpoints":
        result = await session.simple("setFunctionBreakpoints", { breakpoints: safeArray(args.breakpoints) }, args.timeoutMs || 30000);
        break;
      case "setExceptionBreakpoints":
        result = await session.simple("setExceptionBreakpoints", {
          filters: safeArray(args.filters),
          filterOptions: safeArray(args.filterOptions),
          exceptionOptions: safeArray(args.exceptionOptions),
        }, args.timeoutMs || 30000);
        break;
      case "setInstructionBreakpoints":
        result = await session.simple("setInstructionBreakpoints", { breakpoints: safeArray(args.breakpoints) }, args.timeoutMs || 30000);
        break;
      case "setDataBreakpoints":
        result = await session.simple("setDataBreakpoints", { breakpoints: safeArray(args.breakpoints) }, args.timeoutMs || 30000);
        break;
      case "dataBreakpointInfo":
        result = await session.simple("dataBreakpointInfo", {
          variablesReference: Number(args.variablesReference || 0),
          name: String(args.name || ""),
        }, args.timeoutMs || 30000);
        break;
      case "configurationDone":
        result = await session.simple("configurationDone", {}, args.timeoutMs || 30000);
        break;
      case "continue":
        result = await session.simple("continue", {
          threadId: Number(args.threadId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "next":
        result = await session.simple("next", {
          threadId: Number(args.threadId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "stepIn":
        result = await session.simple("stepIn", {
          threadId: Number(args.threadId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "stepOut":
        result = await session.simple("stepOut", {
          threadId: Number(args.threadId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "pause":
        result = await session.simple("pause", {
          threadId: Number(args.threadId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "stackTrace":
        result = await session.simple("stackTrace", {
          threadId: Number(args.threadId || 0),
          startFrame: Number(args.startFrame || 0),
          levels: Number(args.levels || 20),
        }, args.timeoutMs || 30000);
        break;
      case "scopes":
        result = await session.simple("scopes", {
          frameId: Number(args.frameId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "variables":
        result = await session.simple("variables", {
          variablesReference: Number(args.variablesReference || 0),
          filter: args.filter,
          start: args.start,
          count: args.count,
          format: args.format,
        }, args.timeoutMs || 30000);
        break;
      case "setVariable":
        result = await session.simple("setVariable", {
          variablesReference: Number(args.variablesReference || 0),
          name: String(args.name || ""),
          value: String(args.value || ""),
          format: args.format,
        }, args.timeoutMs || 30000);
        break;
      case "evaluate":
        result = await session.simple("evaluate", {
          expression: String(args.expression || ""),
          frameId: args.frameId,
          context: args.context,
          format: args.format,
        }, args.timeoutMs || 30000);
        break;
      case "threads":
        result = await session.simple("threads", {}, args.timeoutMs || 30000);
        break;
      case "source":
        result = await session.simple("source", {
          source: args.source || (args.path ? { path: path.resolve(String(args.path)) } : undefined),
          sourceReference: Number(args.sourceReference || 0),
        }, args.timeoutMs || 30000);
        break;
      case "exceptionInfo":
        result = await session.simple("exceptionInfo", {
          threadId: Number(args.threadId || 0),
        }, args.timeoutMs || 30000);
        break;
      case "readMemory":
        result = await session.simple("readMemory", {
          memoryReference: String(args.memoryReference || ""),
          count: Number(args.count || 0),
          offset: Number(args.offset || 0),
        }, args.timeoutMs || 30000);
        break;
      case "disassemble":
        result = await session.simple("disassemble", {
          memoryReference: String(args.memoryReference || ""),
          offset: Number(args.offset || 0),
          instructionOffset: Number(args.instructionOffset || 0),
          instructionCount: Number(args.instructionCount || args.count || 20),
        }, args.timeoutMs || 30000);
        break;
      case "events":
        result = {
          session: session.id,
          events: session.recentEvents(Number(args.after || 0), Number(args.limit || 50)),
        };
        break;
      default:
        throw new Error(`unknown dap op: ${op}`);
    }
    return {
      session: session.id,
      language: session.language,
      result,
      text: stringify(result),
      events: session.recentEvents(Number(args.after || 0), Number(args.limit || 50)),
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return {
      session: session.id,
      language: session.language,
      isError: true,
      error: msg,
      text: msg,
      events: session.recentEvents(Number(args.after || 0), Number(args.limit || 50)),
    };
  }
}

function listTools() {
  return [
    {
      name: "dap",
      description: "Grouped DAP surface for RVM debug sessions.",
      inputSchema: toolSchema(),
    },
  ];
}

module.exports = {
  getSession,
  callTool,
  listTools,
  toolSchema,
  normalizeLanguage,
  findAdapterSpec,
};

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { pathToFileURL, fileURLToPath } = require("url");
const { StdioRpcClient, parseCommandSpec, resolveExecutableOnPath, formatInstallHint } = require("./stdio-rpc.js");

const SESSION_IDLE_MS = 120000;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function absPath(p, fallbackRoot) {
  if (!p) return null;
  if (String(p).startsWith("file://")) {
    try { return fileURLToPath(String(p)); } catch {}
  }
  const base = fallbackRoot || process.cwd();
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

function fileUri(filePath) {
  return pathToFileURL(filePath).href;
}

function normalizeUriKey(uri) {
  const raw = String(uri || "");
  if (!raw.startsWith("file://")) return raw;
  try {
    const pathname = decodeURIComponent(new URL(raw).pathname || "");
    const normalized = pathname.replace(/^\/([a-zA-Z]):/, (_, drive) => `/${drive.toLowerCase()}:`);
    return `file://${normalized}`;
  } catch {
    return raw;
  }
}

function resolveInputPath(input, fallbackRoot) {
  if (!input) return null;
  if (String(input).startsWith("file://")) {
    try { return fileURLToPath(String(input)); } catch {}
  }
  return absPath(input, fallbackRoot);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeLogger(logger) {
  return typeof logger === "function" ? logger : () => {};
}

function languageIdFromFile(filePath, language) {
  const ext = path.extname(filePath || "").toLowerCase();
  const lang = String(language || "").toLowerCase();
  if (lang) return lang;
  switch (ext) {
    case ".ts": return "typescript";
    case ".tsx": return "typescriptreact";
    case ".js": return "javascript";
    case ".jsx": return "javascriptreact";
    case ".py": return "python";
    case ".rs": return "rust";
    case ".go": return "go";
    case ".c": return "c";
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
    case ".hh":
    case ".h":
      return "cpp";
    default:
      return "plaintext";
  }
}

function normalizeLanguage(language) {
  const candidate = String(language || "").trim().toLowerCase();
  if (!candidate) return "";
  if (["ts", "tsx", "typescript", "typescriptreact"].includes(candidate)) return "typescript";
  if (["js", "jsx", "javascript", "javascriptreact"].includes(candidate)) return "javascript";
  if (["py", "python"].includes(candidate)) return "python";
  if (["rs", "rust"].includes(candidate)) return "rust";
  if (["go", "golang"].includes(candidate)) return "go";
  if (["c", "clang"].includes(candidate)) return "c";
  if (["cpp", "c++", "cc", "cxx"].includes(candidate)) return "cpp";
  if (candidate.includes("typescript")) return "typescript";
  if (candidate.includes("javascript")) return "javascript";
  if (candidate.includes("python")) return "python";
  if (candidate.includes("rust")) return "rust";
  if (candidate.includes("golang") || candidate.includes("go")) return "go";
  if (candidate.includes("c++") || candidate.includes("cpp")) return "cpp";
  if (candidate.includes("clang")) return "c";
  return candidate;
}

function languageForArgs(args = {}) {
  const explicit = normalizeLanguage(args.language || args.lang || args.fileLanguage || "");
  if (explicit) return explicit;
  return languageIdFromFile(args.path || args.file || "", "");
}

function buildRegistry() {
  return {
    typescript: {
      env: ["RVM_LSP_TYPESCRIPT", "RVM_LSP_TS", "RVM_LSP_JS"],
      specs: [["typescript-language-server", ["--stdio"]]],
      install: "npm i -g typescript-language-server typescript",
    },
    javascript: {
      env: ["RVM_LSP_JAVASCRIPT", "RVM_LSP_JS", "RVM_LSP_TYPESCRIPT"],
      specs: [["typescript-language-server", ["--stdio"]]],
      install: "npm i -g typescript-language-server typescript",
    },
    python: {
      env: ["RVM_LSP_PYTHON"],
      specs: [["pyright-langserver", ["--stdio"]], ["pylsp", []]],
      install: "pipx install pyright  # or: pip install python-lsp-server",
    },
    rust: {
      env: ["RVM_LSP_RUST"],
      specs: [["rust-analyzer", []]],
      install: "rustup component add rust-analyzer",
    },
    go: {
      env: ["RVM_LSP_GO"],
      specs: [["gopls", []]],
      install: "go install golang.org/x/tools/gopls@latest",
    },
    c: {
      env: ["RVM_LSP_C", "RVM_LSP_CPP"],
      specs: [["clangd", []]],
      install: "install clangd (e.g. apt install clangd / brew install llvm)",
    },
    cpp: {
      env: ["RVM_LSP_CPP", "RVM_LSP_C"],
      specs: [["clangd", []]],
      install: "install clangd (e.g. apt install clangd / brew install llvm)",
    },
  };
}

function findLaunchSpec(language) {
  const registry = buildRegistry();
  const key = normalizeLanguage(language);
  const entry = registry[key] || registry.typescript;
  for (const envKey of entry.env) {
    const val = (process.env[envKey] || "").trim();
    if (!val) continue;
    const { command, args } = parseCommandSpec(val);
    if (command) return { command, args, source: `env:${envKey}`, install: entry.install };
  }
  for (const [command, args] of entry.specs) {
    const resolved = resolveExecutableOnPath(command);
    if (!resolved) continue;
    if (key === "rust") {
      const probe = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (probe.status !== 0) continue;
    }
    return { command: resolved, args, source: "path", install: entry.install };
  }
  const first = entry.specs[0];
  const hint = formatInstallHint(first ? first[0] : key, entry.install);
  const err = new Error(hint);
  err.language = key;
  throw err;
}

function toLineChar(line, character) {
  const l = Math.max(0, Number(line || 1) - 1);
  const c = Math.max(0, Number(character || 1) - 1);
  return { line: l, character: c };
}

function lspPosition(line, character) {
  const { line: l, character: c } = toLineChar(line, character);
  return { line: l, character: c };
}

function formatLocation(item) {
  if (!item) return null;
  const loc = item.targetUri ? item : item.uri ? item : item.location || item.targetSelectionRange || item.targetRange ? item : null;
  if (!loc) return null;
  const uri = loc.uri || loc.targetUri || loc.location?.uri || loc.targetSelectionRange?.uri || null;
  const range = loc.range || loc.targetRange || loc.selectionRange || loc.location?.range || loc.targetSelectionRange?.range || null;
  if (!uri || !range) return JSON.stringify(loc);
  const start = range.start || range;
  return {
    uri,
    path: uri.startsWith("file://") ? fileUrlToPath(uri) : uri,
    line: (start.line || 0) + 1,
    character: (start.character || 0) + 1,
    text: item.name || item.detail || item.containerName || "",
  };
}

function fileUrlToPath(uri) {
  try {
    return new URL(uri).pathname ? decodeURIComponent(new URL(uri).pathname) : uri;
  } catch {
    return uri;
  }
}

function stringifyResult(value) {
  return JSON.stringify(value, null, 2);
}

class LspSession {
  constructor(language, workspaceRoot, logger) {
    this.language = normalizeLanguage(language) || "plaintext";
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.logger = normalizeLogger(logger);
    this.id = uuid();
    this.client = null;
    this.capabilities = {};
    this.serverInfo = {};
    this.openDocs = new Map();
    this.diagnostics = new Map();
    this.lastUsed = Date.now();
    this.idleTimer = null;
    this.started = false;
    this.startPromise = null;
    this.shutdownPromise = null;
  }

  touch() {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose().catch(() => {}), SESSION_IDLE_MS);
  }

  async ensureStarted() {
    if (this.started) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const spec = findLaunchSpec(this.language);
      const env = { ...process.env };
      this.client = new StdioRpcClient([spec.command, ...spec.args], {
        cwd: this.workspaceRoot,
        env,
        name: `lsp:${this.language}`,
        onNotification: (method, params) => this.handleNotification(method, params),
        onStderr: (text) => this.logger(`[lsp:${this.language}] ${text.trim()}`),
        onExit: (err) => {
          this.logger(`[lsp:${this.language}] exited: ${String(err && err.message || err)}`);
          this.started = false;
        },
      });
      const init = await this.client.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "rvm", version: "1.0" },
        rootUri: pathToFileURL(this.workspaceRoot).href,
        workspaceFolders: [{ uri: pathToFileURL(this.workspaceRoot).href, name: path.basename(this.workspaceRoot) || "workspace" }],
        capabilities: {
          workspace: {
            workspaceEdit: { documentChanges: true },
            didChangeWatchedFiles: { dynamicRegistration: false },
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              didSave: true,
              willSaveWaitUntil: false,
            },
            completion: { completionItem: { snippetSupport: true } },
            hover: {},
            definition: {},
            typeDefinition: {},
            implementation: {},
            references: {},
            publishDiagnostics: { relatedInformation: true },
            diagnostic: { dynamicRegistration: false },
            documentSymbol: {},
            codeAction: {},
            formatting: {},
            signatureHelp: {},
            rename: {},
            callHierarchy: {},
          },
        },
      }, 30000);
      this.capabilities = init.capabilities || {};
      this.serverInfo = init.serverInfo || {};
      this.client.notify("initialized", {});
      this.started = true;
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
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      try {
        if (this.client) {
          try {
            await this.client.request("shutdown", {}, 5000);
          } catch {}
          try {
            this.client.notify("exit", {});
          } catch {}
          this.client.close();
        }
      } finally {
        this.started = false;
        this.client = null;
      }
    })();
    return this.shutdownPromise;
  }

  handleNotification(method, params) {
    if (method === "textDocument/publishDiagnostics" && params && params.uri) {
      this.diagnostics.set(normalizeUriKey(params.uri), {
        uri: params.uri,
        diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
        source: "publishDiagnostics",
      });
      return;
    }
    if (method === "window/logMessage") {
      this.logger(`[lsp:${this.language}] ${params && params.message ? params.message : method}`);
    }
  }

  async ensureDoc(filePath) {
    const p = resolveInputPath(filePath, this.workspaceRoot);
    if (!p) throw new Error("path required");
    const uri = fileUri(p);
    const text = readFileSafe(p);
    const languageId = languageIdFromFile(p, this.language);
    const cached = this.openDocs.get(uri);
    if (!cached) {
      this.client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.openDocs.set(uri, { text, version: 1, languageId });
    } else if (cached.text !== text) {
      const version = (cached.version || 1) + 1;
      this.client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      this.openDocs.set(uri, { text, version, languageId: cached.languageId || languageId });
    }
    this.touch();
    return { uri, text, languageId, path: p };
  }

  async requestTextDocument(method, filePath, extra = {}, timeoutMs = 30000) {
    await this.ensureStarted();
    const doc = await this.ensureDoc(filePath);
    const params = { textDocument: { uri: doc.uri }, ...extra };
    return this.client.request(method, params, timeoutMs);
  }

  async requestPosition(method, args, extra = {}, timeoutMs = 30000) {
    const doc = await this.ensureDoc(args.path || args.file || args.uri || "");
    const { line, character } = lspPosition(args.line, args.character);
    return this.client.request(method, {
      textDocument: { uri: doc.uri },
      position: { line, character },
      ...extra,
    }, timeoutMs);
  }

  async call(op, args = {}) {
    await this.ensureStarted();
    this.touch();
    switch (op) {
      case "definition":
        return this.callLocations("textDocument/definition", args);
      case "typeDefinition":
        return this.callLocations("textDocument/typeDefinition", args);
      case "implementation":
        return this.callLocations("textDocument/implementation", args);
      case "references":
        return this.callLocations("textDocument/references", args, { context: { includeDeclaration: args.includeDeclaration !== false } });
      case "hover":
        return this.callHover(args);
      case "documentSymbol":
        return this.callDocumentSymbol(args);
      case "workspaceSymbol":
        return this.callWorkspaceSymbol(args);
      case "completion":
        return this.callCompletion(args);
      case "signatureHelp":
        return this.callSignatureHelp(args);
      case "rename":
        return this.callRename(args);
      case "diagnostics":
        return this.callDiagnostics(args);
      case "codeAction":
        return this.callCodeAction(args);
      case "formatting":
        return this.callFormatting(args);
      case "callHierarchy":
        return this.callCallHierarchy(args);
      default:
        throw new Error(`unknown lsp op: ${op}`);
    }
  }

  async callLocations(method, args, extra = {}) {
    const res = await this.requestPosition(method, args, extra, 30000);
    return Array.isArray(res) ? res.map(formatLocation).filter(Boolean) : [formatLocation(res)].filter(Boolean);
  }

  async callHover(args) {
    const res = await this.requestPosition("textDocument/hover", args);
    if (!res) return null;
    return res.contents || res.content || res;
  }

  async callDocumentSymbol(args) {
    const filePath = args.path || args.file || args.uri;
    const res = await this.requestTextDocument("textDocument/documentSymbol", filePath);
    return res || [];
  }

  async callWorkspaceSymbol(args) {
    const res = await this.client.request("workspace/symbol", { query: String(args.query || "") }, 30000);
    return res || [];
  }

  async callCompletion(args) {
    const doc = await this.ensureDoc(args.path || args.file || args.uri || "");
    const { line, character } = lspPosition(args.line, args.character);
    const params = {
      textDocument: { uri: doc.uri },
      position: { line, character },
    };
    if (args.triggerCharacter) {
      params.context = { triggerKind: 2, triggerCharacter: String(args.triggerCharacter) };
    }
    const res = await this.client.request("textDocument/completion", params, 30000);
    return res || [];
  }

  async callSignatureHelp(args) {
    const res = await this.requestPosition("textDocument/signatureHelp", args);
    return res || null;
  }

  async callRename(args) {
    const fileMoves = Array.isArray(args.files) ? args.files : null;
    if (fileMoves && fileMoves.length) {
      const files = fileMoves.map((m) => ({
        oldUri: fileUri(resolveInputPath(m.oldPath || m.oldUri || m.from || "", this.workspaceRoot)),
        newUri: fileUri(resolveInputPath(m.newPath || m.newUri || m.to || "", this.workspaceRoot)),
      }));
      const res = await this.client.request("workspace/willRenameFiles", { files }, 30000);
      return { kind: "workspaceEdit", edit: res || null };
    }
    const doc = await this.ensureDoc(args.path || args.file || args.uri || "");
    const { line, character } = lspPosition(args.line, args.character);
    const prepare = await this.client.request("textDocument/prepareRename", {
      textDocument: { uri: doc.uri },
      position: { line, character },
    }, 30000);
    if (prepare && prepare.placeholder === undefined && prepare.range === undefined) {
      // Some servers return `null` when prepareRename is unsupported.
      return { prepare: null };
    }
    const res = await this.client.request("textDocument/rename", {
      textDocument: { uri: doc.uri },
      position: { line, character },
      newName: String(args.newName || ""),
    }, 30000);
    return res || null;
  }

  async callDiagnostics(args) {
    const filePath = resolveInputPath(args.path || args.file || args.uri || "", this.workspaceRoot);
    if (!filePath) throw new Error("path required");
    await this.ensureDoc(filePath);
    const uri = fileUri(filePath);
    const uriKey = normalizeUriKey(uri);
    try {
      const res = await this.client.request("textDocument/diagnostic", {
        textDocument: { uri },
        identifier: args.identifier || null,
        previousResultId: args.previousResultId || null,
      }, 30000);
      if (this.hasDiagnosticsPayload(res)) return res;
      return await this.waitForPublishedDiagnostics(uri, uriKey);
    } catch {
      return await this.waitForPublishedDiagnostics(uri, uriKey);
    }
  }

  hasDiagnosticsPayload(value) {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (Array.isArray(value.items)) return value.items.length > 0;
    if (Array.isArray(value.diagnostics)) return value.diagnostics.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  }

  async waitForPublishedDiagnostics(uri, uriKey = normalizeUriKey(uri), timeoutMs = 7500) {
    const deadline = Date.now() + timeoutMs;
    let lastCached;
    while (Date.now() < deadline) {
      const cached = this.diagnostics.get(uriKey);
      if (cached) {
        lastCached = cached;
        if (Array.isArray(cached.diagnostics) && cached.diagnostics.length > 0) return cached;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return lastCached || this.diagnostics.get(uriKey) || { uri, diagnostics: [] };
  }

  async callCodeAction(args) {
    const doc = await this.ensureDoc(args.path || args.file || args.uri || "");
    const range = this.makeRange(args);
    const res = await this.client.request("textDocument/codeAction", {
      textDocument: { uri: doc.uri },
      range,
      context: {
        diagnostics: Array.isArray(args.diagnostics) ? args.diagnostics : [],
        only: Array.isArray(args.only) ? args.only : (args.only ? [args.only] : undefined),
      },
    }, 30000);
    return res || [];
  }

  async callFormatting(args) {
    const doc = await this.ensureDoc(args.path || args.file || args.uri || "");
    const res = await this.client.request("textDocument/formatting", {
      textDocument: { uri: doc.uri },
      options: {
        tabSize: Number(args.tabSize || 2),
        insertSpaces: args.insertSpaces !== false,
        trimTrailingWhitespace: args.trimTrailingWhitespace !== false,
        insertFinalNewline: args.insertFinalNewline !== false,
      },
    }, 30000);
    return res || [];
  }

  async callCallHierarchy(args) {
    const doc = await this.ensureDoc(args.path || args.file || args.uri || "");
    const { line, character } = lspPosition(args.line, args.character);
    const prepare = await this.client.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: doc.uri },
      position: { line, character },
    }, 30000);
    const items = Array.isArray(prepare) ? prepare : (prepare ? [prepare] : []);
    if (!items.length) return [];
    const item = items[0];
    const direction = String(args.direction || "incoming");
    const method = direction === "outgoing" ? "callHierarchy/outgoingCalls" : "callHierarchy/incomingCalls";
    const res = await this.client.request(method, { item }, 30000);
    return res || [];
  }

  makeRange(args) {
    const start = lspPosition(args.line || args.startLine || 1, args.character || args.startCharacter || 1);
    if (args.endLine || args.endCharacter) {
      const end = lspPosition(args.endLine || args.line || 1, args.endCharacter || args.character || 1);
      return { start, end };
    }
    return { start, end: { line: start.line, character: start.character + 1 } };
  }
}

const sessionByKey = new Map();

function sessionKey(language, workspaceRoot) {
  return `${normalizeLanguage(language)}:${path.resolve(workspaceRoot || process.cwd())}`;
}

function getSession(language, workspaceRoot, logger) {
  const key = sessionKey(language, workspaceRoot);
  let session = sessionByKey.get(key);
  if (!session) {
    session = new LspSession(language, workspaceRoot, logger);
    sessionByKey.set(key, session);
  }
  session.touch();
  return session;
}

function toolSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      op: {
        type: "string",
        enum: [
          "definition",
          "typeDefinition",
          "implementation",
          "references",
          "hover",
          "documentSymbol",
          "workspaceSymbol",
          "completion",
          "signatureHelp",
          "rename",
          "diagnostics",
          "codeAction",
          "formatting",
          "callHierarchy",
        ],
      },
      language: { type: "string" },
      path: { type: "string" },
      file: { type: "string" },
      uri: { type: "string" },
      root: { type: "string" },
      workspaceRoot: { type: "string" },
      line: { type: "number" },
      character: { type: "number" },
      endLine: { type: "number" },
      endCharacter: { type: "number" },
      query: { type: "string" },
      newName: { type: "string" },
      files: { type: "array" },
      direction: { type: "string" },
      includeDeclaration: { type: "boolean" },
      triggerCharacter: { type: "string" },
      tabSize: { type: "number" },
      insertSpaces: { type: "boolean" },
      trimTrailingWhitespace: { type: "boolean" },
      insertFinalNewline: { type: "boolean" },
      diagnostics: { type: "array" },
      only: { type: ["array", "string"] },
    },
  };
}

function toolErrorMessage(err, language) {
  const base = String((err && err.message) || err);
  if (/找不到可执行文件/.test(base)) {
    return base;
  }
  return language ? `${language} LSP 失败: ${base}` : base;
}

async function dispatch(workspaceRoot, args = {}, logger) {
  const op = String(args.op || "");
  const language = args.language || args.lang || args.fileLanguage || "";
  const resolvedRoot = absPath(args.root || args.workspaceRoot || workspaceRoot, workspaceRoot || process.cwd());
  const session = getSession(language || languageForArgs(args), resolvedRoot, logger);
  try {
    const result = await session.call(op, { ...args, workspaceRoot: resolvedRoot });
    return {
      session: session.id,
      language: session.language,
      workspaceRoot: session.workspaceRoot,
      result,
      text: stringifyResult(result),
    };
  } catch (err) {
    const text = toolErrorMessage(err, session.language);
    return {
      session: session.id,
      language: session.language,
      workspaceRoot: session.workspaceRoot,
      error: text,
      isError: true,
      text,
    };
  }
}

async function callTool(workspaceRoot, args = {}, logger) {
  return dispatch(workspaceRoot, args, logger);
}

function listTools() {
  return [
    {
      name: "lsp",
      description: "Lightweight grouped LSP surface for RVM. Use op with language/path/root/position fields.",
      inputSchema: toolSchema(),
    },
  ];
}

module.exports = {
  getSession,
  callTool,
  dispatch,
  listTools,
  toolSchema,
  normalizeLanguage,
  findLaunchSpec,
};

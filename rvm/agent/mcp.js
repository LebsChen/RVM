"use strict";
// MCP Streamable HTTP endpoint — exposes agent tools via Model Context Protocol
// Maps to official devin-remote execute_mcp + managed_plugins.rs
// Implements MCP Streamable HTTP transport (JSON-RPC over HTTP POST)

const os = require("os");
const lsp = require("./lsp.js");
const dap = require("./dap.js");
const browser = require("./browser.js");

// Resolve the base URL clients should use to reach this host's proxied
// endpoints (/ide, /novnc, /vnc-ws). When a cloudflared tunnel is up the agent
// records its public URL in conn.json; report that so the URL is reachable
// off-box. Fall back to localhost only when there is no public URL.
function resolvePublicBase(conf) {
  const fs = require("fs");
  const path = require("path");
  let pub = "";
  try {
    const connFile = path.join(process.env.CONN_DIR || __dirname, "conn.json");
    const c = JSON.parse(fs.readFileSync(connFile, "utf8"));
    pub = c && typeof c.publicUrl === "string" ? c.publicUrl.trim() : "";
  } catch { /* best-effort: fall back to localhost */ }
  if (pub) {
    const http = pub.replace(/\/+$/, "");
    const ws = http.replace(/^http/i, "ws"); // https -> wss, http -> ws
    return { http, ws };
  }
  return { http: `http://localhost:${conf.port}`, ws: `ws://localhost:${conf.port}` };
}

const TOOLS = [
  { name: "shell_exec", description: "Execute a shell command", inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" }, session: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file content", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Edit file by replacing old_string with new_string", inputSchema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "list_dir", description: "List directory contents", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "screenshot", description: "Take a screenshot of the desktop", inputSchema: { type: "object", properties: {} } },
  { name: "computer_click", description: "Click at screen coordinates", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" } }, required: ["x", "y"] } },
  { name: "computer_type", description: "Type text on keyboard", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "computer_key", description: "Press a key combination", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "git_status", description: "Get git repository status", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
  { name: "git_clone", description: "Clone a git repository", inputSchema: { type: "object", properties: { url: { type: "string" }, dest: { type: "string" }, branch: { type: "string" } }, required: ["url"] } },
  { name: "git_diff", description: "Show git diff", inputSchema: { type: "object", properties: { cwd: { type: "string" }, ref: { type: "string" } } } },
  { name: "upload_file", description: "Upload a file from base64 content or an HTTP(S) URL", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, url: { type: "string" }, encoding: { type: "string" } }, required: ["path"], oneOf: [{ required: ["content"] }, { required: ["url"] }], not: { required: ["content", "url"] } } },
  { name: "download_file", description: "Download file content (base64)", inputSchema: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } }, required: ["path"] } },
  { name: "get_desktop_url", description: "Get noVNC desktop URL for browser access", inputSchema: { type: "object", properties: {} } },
  { name: "get_ide_url", description: "Get code-server Web IDE URL", inputSchema: { type: "object", properties: {} } },
  { name: "system_info", description: "Get system information", inputSchema: { type: "object", properties: {} } },
  { name: "lsp", description: "Grouped LSP tool surface", inputSchema: lsp.toolSchema() },
  { name: "dap", description: "Grouped DAP tool surface", inputSchema: dap.toolSchema() },
  { name: "browser_navigate", description: "Navigate the headless browser to a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_eval", description: "Evaluate JavaScript in the browser page", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
  { name: "browser_screenshot", description: "Capture a screenshot of the browser page", inputSchema: { type: "object", properties: {} } },
  { name: "browser_close", description: "Close the headless browser", inputSchema: { type: "object", properties: {} } },
];

async function handleRoute(route, method, body, conf, token) {
  // MCP Streamable HTTP: POST /mcp for JSON-RPC
  if (method !== "POST") {
    return { status: 405, body: { error: "MCP endpoint only accepts POST" } };
  }

  const jsonrpc = body;
  if (!jsonrpc || !jsonrpc.method) {
    return { status: 400, body: { error: "invalid JSON-RPC request" } };
  }

  const id = jsonrpc.id;
  const rpcMethod = jsonrpc.method;
  const params = jsonrpc.params || {};

  switch (rpcMethod) {
    case "initialize":
      return mcpResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rvm", version: "1.0.32" },
      });

    case "tools/list":
      return mcpResponse(id, { tools: TOOLS });

    case "tools/call":
      return handleToolCall(id, params, conf, token);

    case "resources/list":
      return mcpResponse(id, { resources: [] });

    case "prompts/list":
      return mcpResponse(id, { prompts: [] });

    case "ping":
      return mcpResponse(id, {});

    case "notifications/initialized":
      return { status: 200, body: { jsonrpc: "2.0" } };

    default:
      return mcpError(id, -32601, `Method not found: ${rpcMethod}`);
  }
}

async function handleToolCall(id, params, conf, token) {
  const { name, arguments: args } = params;
  if (!name) return mcpError(id, -32602, "tool name required");

  const core = require("./core.js");
  const fs = require("fs");
  const path = require("path");
  const workspaceRoot = conf.root || process.cwd();
  const logger = typeof conf.log === "function" ? conf.log : console.error;

  try {
    switch (name) {
      case "shell_exec": {
        const r = await core.runShell(args.command, args.cwd, (args.timeout || 30) * 1000, args.session, conf.root);
        return mcpToolResult(id, `Exit: ${r.exit_code}\nStdout:\n${r.stdout}\nStderr:\n${r.stderr}`);
      }
      case "read_file": {
        const content = fs.readFileSync(args.path, "utf8");
        return mcpToolResult(id, content);
      }
      case "write_file": {
        const dir = path.dirname(args.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.path, args.content, "utf8");
        return mcpToolResult(id, `Written ${Buffer.byteLength(args.content)} bytes to ${args.path}`);
      }
      case "edit_file": {
        let content = fs.readFileSync(args.file_path, "utf8");
        const idx = content.indexOf(args.old_string);
        if (idx === -1) return mcpToolResult(id, "Error: old_string not found in file", true);
        content = content.slice(0, idx) + args.new_string + content.slice(idx + args.old_string.length);
        fs.writeFileSync(args.file_path, content, "utf8");
        return mcpToolResult(id, `Edited ${args.file_path}`);
      }
      case "list_dir": {
        const items = fs.readdirSync(args.path, { withFileTypes: true }).map((d) => `${d.isDirectory() ? "[D]" : "[F]"} ${d.name}`);
        return mcpToolResult(id, items.join("\n"));
      }
      case "screenshot": {
        const r = await core.handleComputerUse({ action: "screenshot" });
        if (r.error) return mcpToolResult(id, `Error: ${r.error}`, true);
        return mcpResponse(id, { content: [{ type: "image", data: r.image, mimeType: "image/png" }] });
      }
      case "computer_click": {
        const r = await core.handleComputerUse({ action: "click", coordinate: [args.x, args.y], button: args.button });
        return mcpToolResult(id, r.ok ? "Clicked" : `Error: ${r.stderr || "click failed"}`);
      }
      case "computer_type": {
        const r = await core.handleComputerUse({ action: "type", text: args.text });
        return mcpToolResult(id, r.ok ? "Typed" : `Error: ${r.stderr || "type failed"}`);
      }
      case "computer_key": {
        const r = await core.handleComputerUse({ action: "key", key: args.key });
        return mcpToolResult(id, r.ok ? "Key pressed" : `Error: ${r.stderr || "key failed"}`);
      }
      case "git_status": {
        const git = require("./git.js");
        const result = await git.handleRoute("/api/git/status", "POST", { cwd: args.cwd || conf.root }, conf.root);
        return mcpToolResult(id, JSON.stringify(result.body, null, 2));
      }
      case "git_clone": {
        const git = require("./git.js");
        const result = await git.handleRoute("/api/git/clone", "POST", args, conf.root);
        return mcpToolResult(id, JSON.stringify(result.body, null, 2));
      }
      case "git_diff": {
        const git = require("./git.js");
        const result = await git.handleRoute("/api/git/diff", "POST", { cwd: args.cwd || conf.root, ref: args.ref }, conf.root);
        return mcpToolResult(id, result.body.diff || "(no diff)");
      }
      case "upload_file": {
        const storage = require("./storage.js");
        const result = await storage.handleUpload({}, args);
        return mcpToolResult(id, JSON.stringify(result.body));
      }
      case "download_file": {
        const storage = require("./storage.js");
        const result = storage.handleDownload(args);
        return mcpToolResult(id, result.body.content || JSON.stringify(result.body));
      }
      case "get_desktop_url": {
        const b = resolvePublicBase(conf);
        const novncPath = encodeURIComponent(`vnc-ws?token=${token || ""}`);
        return mcpToolResult(id, `VNC Desktop: ${b.ws}/vnc-ws\nnoVNC: ${b.http}/novnc/vnc.html?autoconnect=true&resize=scale&show_dot=true&path=${novncPath}`);
      }
      case "get_ide_url": {
        const b = resolvePublicBase(conf);
        return mcpToolResult(id, `Web IDE: ${b.http}/ide/?tkn=${encodeURIComponent(token || "")}`);
      }
      case "system_info":
        return mcpToolResult(id, JSON.stringify({
          hostname: os.hostname(),
          platform: process.platform,
          arch: os.arch(),
          cpus: os.cpus().length,
          memory_gb: Math.round(os.totalmem() / 1073741824 * 10) / 10,
          node: process.version,
        }, null, 2));
      case "lsp": {
        const result = await lsp.dispatch(workspaceRoot, args, logger);
        return mcpToolResult(id, result.text || JSON.stringify(result, null, 2), Boolean(result.isError));
      }
      case "dap": {
        const result = await dap.callTool(workspaceRoot, args, logger);
        return mcpToolResult(id, result.text || JSON.stringify(result, null, 2), Boolean(result.isError));
      }
      case "browser_navigate":
        return mcpToolResult(id, JSON.stringify(await browser.navigate(args.url), null, 2));
      case "browser_eval":
        return mcpToolResult(id, JSON.stringify(await browser.evaluate(args.expression), null, 2));
      case "browser_screenshot":
        return mcpResponse(id, { content: [{ type: "image", data: await browser.screenshot(), mimeType: "image/png" }] });
      case "browser_close":
        await browser.close();
        return mcpToolResult(id, "Browser closed");
      default:
        return mcpError(id, -32602, `Unknown tool: ${name}`);
    }
  } catch (e) {
    return mcpToolResult(id, `Error: ${e.message || e}`, true);
  }
}

function mcpResponse(id, result) {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function mcpError(id, code, message) {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function mcpToolResult(id, text, isError) {
  return mcpResponse(id, {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  });
}

module.exports = { handleRoute };

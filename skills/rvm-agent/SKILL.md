---
name: rvm-agent
description: Comprehensive skill guide for managing and executing operations via RVM (Remote Virtual Machine) Agent, including shell execution, file system management, system services, LSP/DAP debugging, MCP tools, and tunneling.
---

# RVM Agent Skill Guide

The **RVM (Remote Virtual Machine) Agent** is a local daemon running on port `9876` that acts as the core controller for AI Agents executing tasks inside a sandboxed workspace or VM.

---

## 🛠️ Key Capabilities

1. **Bash Command Execution (`exec`)**: Run synchronous or asynchronous bash shell commands, manage processes, stream logs, and check exit status.
2. **File System Operations (`file`)**: Read, write, list, delete, edit, and monitor files inside `/workspace`.
3. **LSP Intelligence (`lsp`)**: Query language servers for autocompletion, go-to-definition, symbol search, and code diagnostics.
4. **DAP Step Debugging (`dap`)**: Control interactive debugging sessions (breakpoints, step over, step into, variable inspection).
5. **MCP Protocol Bridge (`mcp`)**: Connect AI models with standardized tool capabilities via Model Context Protocol.
6. **Cloud Tunneling (`tunnel`)**: Expose local web ports to public HTTPS endpoints via Cloudflare (`cloudflared`) or localtunnel.
7. **Package Installer (`installer`)**: Auto-install software packages such as `cloudflared`, `noVNC`, `code-server`, `tightvnc`, `ffmpeg`, and `chromium`.

---

## 📡 Authentication & Request Format

All HTTP requests to RVM Agent require the Authorization header:
```http
Authorization: Bearer devin-rvm-secret-token
Content-Type: application/json
```

Default Base URL: `http://localhost:9876` (or routed via `/api/rvm-exec` in Next.js).

---

## 📋 Common RPC Methods

### 1. Execute Command (`exec`)
```json
{
  "method": "exec",
  "params": {
    "cmd": "npm run test",
    "cwd": "/workspace",
    "env": { "NODE_ENV": "development" },
    "async": false
  }
}
```

### 2. Read / Write File
```json
{
  "method": "file_read",
  "params": {
    "path": "/workspace/package.json"
  }
}
```

```json
{
  "method": "file_write",
  "params": {
    "path": "/workspace/src/index.ts",
    "content": "console.log('Hello RVM');"
  }
}
```

### 3. Expose Port via Tunnel
```json
{
  "method": "expose_port",
  "params": {
    "port": 3000,
    "provider": "cloudflared"
  }
}
```

---

## 💡 Best Practices for AI Agents

- **Sequential Task Logging**: Every execution task generates a sequence entry in `rvm/agent/worklog.jsonl`. Use sequence IDs to verify task completion.
- **Path Resolution**: Always treat `/workspace` as the primary workspace root directory unless specified otherwise.
- **Graceful Failover**: If a system binary (e.g., `cloudflared` or `noVNC`) is missing, invoke `POST /installer/run` with the target package name before retrying.

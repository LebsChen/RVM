# RVM (Remote Virtual Machine Agent)

> **RVM** is an open, high-performance Remote Virtual Machine Agent & Execution Workspace framework designed for AI Coding Agents and Remote Workflows. It bridges LLMs with rich OS-level automation, browser control, code servers, LSP/DAP debugging, MCP tools, VNC desktop access, and cloud tunneling.

---

## 🌟 Key Features

- 🖥️ **Computer Use & Desktop Control**: OS-level mouse, keyboard, screenshot capture, display management, and embedded noVNC web streaming.
- 🌐 **Browser Automation**: Playwright/Puppeteer engine with DOM element annotation, smart visual grounding, clicking, typing, and page inspection.
- ⚡ **Execution & Workspace RPC**: Execute bash commands, run code snippets, handle background processes, manage workspace files, and collect execution logs with sequence tracking.
- 🛠️ **Developer Tools & Protocols**:
  - **LSP (Language Server Protocol)**: Code intelligence, definition lookup, references, and diagnostics.
  - **DAP (Debug Adapter Protocol)**: Interactive step-by-step debugging for multiple runtimes.
  - **MCP (Model Context Protocol)**: Expose RVM tools directly to AI models using standardized MCP interfaces.
  - **Code Server**: Built-in Web IDE integration for seamless browser-based code editing.
- 🌉 **Networking & Cloud Tunnels**: Automatic Cloudflare (`cloudflared`) and HTTP/2 tunnel configuration, port exposing, and public URL generation.
- 🧰 **Auto-Installer Engine**: Zero-config bootstrap for `cloudflared`, `noVNC`, `code-server`, `vnc_server`, `ffmpeg`, `git`, and headless `chromium`.
- 📊 **Next.js Web Console**: Embedded Web Dashboard to configure, monitor, start/stop, and inspect agent logs & RPC commands in real-time.
- 📱 **Cross-Platform Tauri Client**: Native desktop GUI application wrapping the workspace control panel.

---

## 🏗️ Architecture

```
                 +-----------------------------------+
                 |      AI Agent / User Client       |
                 +-----------------------------------+
                                   |
                         (RPC / HTTP / WS)
                                   v
+------------------------------------------------------------------------+
|                    Next.js Web Console (Port 3000)                     |
|                   (/app/page.tsx & /api/rvm/route.ts)                  |
+------------------------------------------------------------------------+
                                   |
                        (Local HTTP API Port 9876)
                                   v
+------------------------------------------------------------------------+
|                     RVM Agent Core (rvm/agent/*)                       |
|                                                                        |
|  +-------------------+  +-------------------+  +--------------------+  |
|  |  Computer Control |  | Browser Engine    |  | Execution Workspace|  |
|  |  (VNC / Mouse /   |  | (Playwright /     |  | (Bash / Files /    |  |
|  |   Keyboard)       |  |  DOM Annotator)   |  |  Worklogs)         |  |
|  +-------------------+  +-------------------+  +--------------------+  |
|  |  LSP / DAP / MCP  |  | Cloud Tunnels     |  | System Installer   |  |
|  |  (Code Intel)     |  | (Cloudflare)      |  | (Auto Dependencies)|  |
|  +-------------------+  +-------------------+  +--------------------+  |
+------------------------------------------------------------------------+
```

---

## 🚀 Quick Start

### 1. Requirements
- Node.js 18+ or Bun
- Docker & Docker Compose (Optional, for containerized isolation)
- Linux / macOS / Windows (WSL2)

### 2. Run with Docker Compose

```bash
docker-compose up -d
```

This starts:
- Next.js Web Dashboard on `http://localhost:3000`
- RVM Agent Daemon listening on `http://localhost:9876`

### 3. Run Locally

```bash
# Install dependencies
npm install

# Start Next.js Development Server
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## 📡 RVM Agent API & RPC

The RVM Agent runs an HTTP server on port `9876` with a bearer token authentication header:

`Authorization: Bearer <rvm_token>` (Default: `devin-rvm-secret-token`)

### Key Endpoints & Commands

| Endpoint / Method | Description |
| ----------------- | ----------- |
| `GET /status` | Returns agent status, uptime, system stats, and active features. |
| `POST /rpc` | General RPC dispatcher for agent functions (`exec`, `file`, `computer`, `browser`, `lsp`, `dap`, `mcp`). |
| `POST /computer/action` | Perform OS GUI actions: mouse move/click, keyboard input, key combinations, screenshot. |
| `POST /browser/action` | Control automated browser: navigate, click element ID, type text, extract DOM text. |
| `GET /vnc` / `GET /novnc` | Interactive web VNC screen stream. |
| `POST /installer/run` | Trigger automatic installation of missing system packages. |

#### Example RPC Request (`POST /rpc`)
```json
{
  "method": "exec",
  "params": {
    "cmd": "git status",
    "cwd": "/workspace"
  }
}
```

---

## 💡 Agent Skills (`skills/`)

RVM provides pre-packaged agent skills inside `skills/` for easy integration with AI systems:

- [`skills/rvm-agent/SKILL.md`](./skills/rvm-agent/SKILL.md): Core skill guide for interacting with RVM Agent API, workspace control, execution & system features.
- [`skills/computer-use/SKILL.md`](./skills/computer-use/SKILL.md): OS Desktop GUI automation, mouse/keyboard input, and screen navigation guide.
- [`skills/browser-automation/SKILL.md`](./skills/browser-automation/SKILL.md): Playwright/Puppeteer web automation, DOM annotation, and element targeting guide.

---

## 📄 Environment Configuration (`.env.example`)

```env
PORT=3000
GEMINI_API_KEY=
NEXT_PUBLIC_GEMINI_API_KEY=
APP_URL="MY_APP_URL"
GH_PAT=
```

---

## 📜 License

MIT License. Developed for automated AI workspaces and agent execution environments.

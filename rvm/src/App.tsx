import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type AgentStatus = "stopped" | "starting" | "running" | "error";

interface AgentState {
  status: AgentStatus;
  port: number;
  token: string;
  host: string;
  platform: string;
  direct_url: string;
  public_url: string;
  vnc_port: number;
  cdp_port: number;
  pid: number;
  error: string;
  workspace: string;
  capability_status: Record<string, string>;
}

interface AgentConfig {
  port: number;
  token: string;
  workspace: string;
  vnc_password: string;
  tunnel_mode: string; // "auto" | "off" | "named"
  tunnel_protocol: string; // "http2" | "quic" | "auto"
  cf_tunnel_token: string;
  public_url: string; // fixed public domain mapped to the named tunnel
  bind_address: string;
  auto_install: string[]; // service ids allowed to auto-install when missing
  github_mirror: string; // optional GitHub download accelerator (prefix or {url})
}

interface OutpostConfig {
  outpost_id: string;
  token: string;
  working_directory: string;
  auto_start: boolean;
}

type OutpostStatus = "stopped" | "starting" | "running" | "error";

interface OutpostState {
  status: OutpostStatus;
  pid: number;
  outpost_id: string;
  auto_start: boolean;
  cli_available: boolean;
  error: string;
}

interface NodeStatus {
  available: boolean;
  version: string;
  path: string;
  managed: boolean;
}

const DEFAULT_STATE: AgentState = {
  status: "stopped",
  port: 9876,
  token: "",
  host: "",
  platform: "",
  direct_url: "",
  public_url: "",
  vnc_port: 0,
  cdp_port: 0,
  pid: 0,
  error: "",
  workspace: "",
  capability_status: {},
};

const DEFAULT_CONFIG: AgentConfig = {
  port: 9876,
  token: "",
  workspace: "",
  vnc_password: "devin",
  tunnel_mode: "auto",
  tunnel_protocol: "http2",
  cf_tunnel_token: "",
  public_url: "",
  bind_address: "0.0.0.0",
  auto_install: ["cloudflared", "novnc", "web_ide", "vnc_server", "ffmpeg", "git", "browser"],
  github_mirror: "https://gh-proxy.com/",
};

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(props.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy">
      {copied ? "\u2713" : "\u2398"}
    </button>
  );
}

function InfoRow(props: { label: string; value: string; pending?: boolean; copyable?: boolean }) {
  return (
    <>
      <span className="info-label">{props.label}</span>
      <span className="flex items-center gap-2">
        <span className={`info-value ${props.pending ? "pending" : ""}`}>
          {props.value || (props.pending ? "..." : "-")}
        </span>
        {props.copyable && props.value && <CopyButton text={props.value} />}
      </span>
    </>
  );
}

function StatusPanel(props: { state: AgentState }) {
  const { state } = props;
  const statusClass = state.status === "running" ? "online" : state.status === "starting" ? "starting" : "offline";
  const statusText = state.status === "running" ? "Running" : state.status === "starting" ? "Starting..." : state.status === "error" ? "Error" : "Stopped";
  const directBase = state.direct_url.replace(/\/+$/, "");
  const endpointBase = (state.public_url.trim() || directBase).replace(/\/+$/, "");
  const wsBase = endpointBase.replace(/^http/i, "ws");

  return (
    <div className="card">
      <div className="card-header">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${statusClass}`} />
          <span className="card-title">RVM (Remote Virtual Machines)</span>
        </div>
        <span className="text-sm text-dim">
          {state.platform && `${state.host} (${state.platform})`}
        </span>
      </div>

      {state.status === "running" && (
        <>
          <div className="info-grid">
            <InfoRow label="Direct URL" value={state.direct_url} copyable />
            <InfoRow label="Public URL" value={state.public_url} pending={!state.public_url} copyable />
            <InfoRow label="Token" value={state.token} copyable />
            <InfoRow label="Workspace" value={state.workspace} />
          </div>
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text)" }}>Endpoints (public when available):</div>
            <div className="info-grid" style={{ fontSize: 12 }}>
              <InfoRow label="API" value={`${endpointBase}/api/`} copyable />
              <InfoRow label="MCP" value={`${endpointBase}/mcp`} copyable />
              <InfoRow label="VNC (WS)" value={`${wsBase}/vnc-ws`} copyable />
              <InfoRow label="PTY (WS)" value={`${wsBase}/pty-ws`} copyable />
              <InfoRow label="CDP (WS)" value={`${wsBase}/cdp-ws`} copyable />
              <InfoRow label="noVNC" value={`${endpointBase}/novnc/`} copyable />
              <InfoRow label="Web IDE" value={`${endpointBase}/ide/?tkn=${encodeURIComponent(state.token)}`} copyable />
              <InfoRow label="Capabilities" value={`${endpointBase}/api/capabilities`} copyable />
            </div>
          </div>
          <div className="info-grid" style={{ marginTop: 8 }}>
            <InfoRow label="PID" value={String(state.pid)} />
            <InfoRow label="Status" value={statusText} />
          </div>
        </>
      )}

      {state.error && (
        <div className="mt-2 text-sm text-red" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>{state.error}</div>
      )}
    </div>
  );
}

function ConfigPanel(props: {
  config: AgentConfig;
  onChange: (c: AgentConfig) => void;
  disabled: boolean;
}) {
  const { config, onChange, disabled } = props;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Configuration</span>
      </div>

      <div className="input-group">
        <label>Port</label>
        <input
          className="input"
          type="number"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: parseInt(e.target.value) || 9876 })}
          disabled={disabled}
        />
      </div>

      <div className="input-group">
        <label>Token (leave empty for auto-generate)</label>
        <input
          className="input"
          value={config.token}
          onChange={(e) => onChange({ ...config, token: e.target.value })}
          placeholder="Auto-generated"
          disabled={disabled}
        />
      </div>

      <div className="input-group">
        <label>Workspace Root</label>
        <input
          className="input"
          value={config.workspace}
          onChange={(e) => onChange({ ...config, workspace: e.target.value })}
          placeholder="Default: user home directory"
          disabled={disabled}
        />
      </div>

      <div className="input-group">
        <label>VNC Password</label>
        <input
          className="input"
          value={config.vnc_password}
          onChange={(e) => onChange({ ...config, vnc_password: e.target.value })}
          disabled={disabled}
        />
      </div>

      <div className="input-group">
        <label>Bind Address</label>
        <input
          className="input"
          value={config.bind_address}
          onChange={(e) => onChange({ ...config, bind_address: e.target.value })}
          disabled={disabled}
        />
      </div>

      <div className="input-group">
        <label>Tunnel Mode</label>
        <select
          className="input"
          value={config.tunnel_mode}
          onChange={(e) => onChange({ ...config, tunnel_mode: e.target.value })}
          disabled={disabled}
        >
          <option value="auto">Auto (Quick Tunnel)</option>
          <option value="off">Off</option>
          <option value="named">Named Tunnel (Cloudflare Token)</option>
        </select>
      </div>

      <div className="input-group">
        <label>Tunnel Protocol</label>
        <select
          className="input"
          value={config.tunnel_protocol}
          onChange={(e) => onChange({ ...config, tunnel_protocol: e.target.value })}
          disabled={disabled || config.tunnel_mode === "off"}
        >
          <option value="http2">HTTP/2 (TCP, recommended)</option>
          <option value="quic">QUIC (UDP, faster but blocked on some VMs)</option>
          <option value="auto">Auto (cloudflared default)</option>
        </select>
      </div>

      {config.tunnel_mode === "named" && (
        <>
          <div className="input-group">
            <label>Cloudflare Tunnel Token</label>
            <input
              className="input"
              value={config.cf_tunnel_token}
              onChange={(e) => onChange({ ...config, cf_tunnel_token: e.target.value })}
              placeholder="eyJ..."
              disabled={disabled}
              type="password"
            />
          </div>
          <div className="input-group">
            <label>Fixed Domain (Public URL)</label>
            <input
              className="input"
              value={config.public_url}
              onChange={(e) => onChange({ ...config, public_url: e.target.value })}
              placeholder="https://local.example.com"
              disabled={disabled}
            />
            <span className="text-sm text-dim">
              The public hostname you mapped to this tunnel in the Cloudflare Zero Trust dashboard. Shown as the Public URL; survives restarts.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function CapabilitiesPanel(props: { state: AgentState }) {
  const capabilities = [
    { id: "shell_execution", name: "Shell Execution", desc: "exec, write_to_process (interactive PTY)" },
    { id: "file_system", name: "File System", desc: "read, write, edit, multi_edit, glob, grep, search, list_dir, upload, download" },
    { id: "computer_use", name: "Computer Use", desc: "screenshot, click, type, key, scroll, move, resolution" },
    { id: "browser_cdp", name: "Browser (CDP)", desc: "Chrome DevTools Protocol proxy, inject cookies, navigate" },
    { id: "vnc_desktop", name: "VNC Desktop", desc: "WebSocket VNC proxy at /vnc-ws" },
    { id: "novnc_web_client", name: "noVNC Web Client", desc: "Browser-based VNC at /novnc/ (auto-download)" },
    { id: "web_ide", name: "Web IDE (code-server)", desc: "VS Code in browser at /ide/ (auto-install)" },
    { id: "pty_terminal", name: "PTY Terminal", desc: "Interactive pseudo-terminal via /pty-ws" },
    { id: "cdp_browser", name: "CDP Browser", desc: "Chrome DevTools Protocol proxy at /cdp-ws" },
    { id: "git_operations", name: "Git Operations", desc: "clone, pull, push, status, diff, checkout, log, branch, merge, rebase, tag, blame" },
    { id: "port_forwarding", name: "Port Forwarding", desc: "Expose local ports via cloudflare tunnel" },
    { id: "mcp_server", name: "MCP Server", desc: "JSON-RPC MCP endpoint at /mcp (Streamable HTTP)" },
    { id: "repo_setup", name: "Repo Setup", desc: "Clone repo, auto-detect stack, install deps, build" },
    { id: "code_scanning", name: "Code Scanning", desc: "Pattern matching, security scanning" },
    { id: "deploy_support", name: "Deploy Support", desc: "ZIP upload, extraction, project deployment" },
    { id: "storage", name: "Storage", desc: "Binary upload/download, stat, copy, rename, hash" },
    { id: "middleware", name: "Middleware", desc: "Pre/post tool hooks, session lifecycle" },
    { id: "event_handling", name: "Event Handling", desc: "Subscribe to remote events" },
    { id: "scratchpad", name: "Scratchpad", desc: "Temporary workspace, key-value store" },
    { id: "recording", name: "Recording", desc: "Screen recording start/stop (ffmpeg)" },
    { id: "notebook", name: "Notebook", desc: "Jupyter .ipynb reading with cell outputs" },
  ];

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">VM Capabilities (devin-remote compatible)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {capabilities.map((c) => (
          <div key={c.id} style={{ fontSize: 12, padding: "4px 0" }}>
            <span
              style={{
                color: props.state.capability_status[c.id] === "ok" ? "var(--green)" : "var(--red)",
                marginRight: 6,
              }}
            >
              *
            </span>
            <span style={{ fontWeight: 500 }}>{c.name}</span>
            <span className="text-dim"> - {c.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogPanel(props: { logs: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [props.logs]);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Logs</span>
        <span className="text-sm text-dim">{props.logs.length} entries</span>
      </div>
      <div className="log-panel" ref={ref}>
        {props.logs.length === 0 ? "No logs yet." : props.logs.join("\n")}
      </div>
    </div>
  );
}

const DEFAULT_OUTPOST_CONFIG: OutpostConfig = {
  outpost_id: "",
  token: "",
  working_directory: "",
  auto_start: false,
};

const DEFAULT_OUTPOST_STATE: OutpostState = {
  status: "stopped",
  pid: 0,
  outpost_id: "",
  auto_start: false,
  cli_available: false,
  error: "",
};

function OutpostsPanel() {
  const [config, setConfig] = useState<OutpostConfig>(DEFAULT_OUTPOST_CONFIG);
  const [state, setState] = useState<OutpostState>(DEFAULT_OUTPOST_STATE);
  const [logs, setLogs] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    invoke<OutpostState>("get_outpost_state").then((s) => {
      if (s) setState(s);
    }).catch(() => {});
    invoke<string[]>("get_outpost_logs").then((next) => {
      if (next) setLogs(next);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    invoke<OutpostConfig>("load_outpost_config").then((c) => {
      if (c) setConfig(c);
    }).catch(() => {});
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (state.status !== "running" && state.status !== "starting") return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [state.status, refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const save = async () => {
    try {
      await invoke("save_outpost_config", { config });
      setMessage("Saved.");
    } catch (e) {
      setMessage(`Save error: ${e}`);
    }
  };

  const start = async () => {
    setBusy(true);
    setMessage("");
    setState((current) => ({ ...current, status: "starting", error: "" }));
    try {
      await invoke("save_outpost_config", { config });
      const next = await invoke<OutpostState>("start_outpost_worker");
      setState(next);
      setMessage("Worker started.");
    } catch (e) {
      setState((current) => ({ ...current, status: "error", error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await invoke("stop_outpost_worker");
      setState(DEFAULT_OUTPOST_STATE);
      setLogs([]);
      setMessage("Worker stopped.");
    } catch (e) {
      setMessage(`Stop error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await invoke<string>("install_node");
      setMessage(result || "Node.js installation completed.");
      refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const isRunning = state.status === "running" || state.status === "starting";

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Devin Outposts / DevBox</span>
        <span className={`text-sm ${isRunning ? "text-green" : "text-dim"}`}>
          {state.status === "running" ? `Running (PID ${state.pid})` : state.status === "starting" ? "Starting..." : state.status === "error" ? "Error" : "Stopped"}
        </span>
      </div>

      <div className="input-group">
        <label>Outpost ID</label>
        <input
          className="input"
          value={config.outpost_id}
          onChange={(e) => setConfig({ ...config, outpost_id: e.target.value })}
          placeholder="outpost_env-..."
          disabled={isRunning}
        />
      </div>
      <div className="input-group">
        <label>Worker Token</label>
        <input
          className="input"
          type="password"
          value={config.token}
          onChange={(e) => setConfig({ ...config, token: e.target.value })}
          placeholder="cog_..."
          disabled={isRunning}
        />
      </div>
      <div className="input-group">
        <label>Working Directory (optional)</label>
        <input
          className="input"
          value={config.working_directory}
          onChange={(e) => setConfig({ ...config, working_directory: e.target.value })}
          placeholder="Default: user home"
          disabled={isRunning}
        />
      </div>
      <label className="flex items-center gap-2 text-sm" style={{ margin: "10px 0" }}>
        <input
          type="checkbox"
          checked={config.auto_start}
          onChange={(e) => setConfig({ ...config, auto_start: e.target.checked })}
          disabled={isRunning}
        />
        Auto-start on launch
      </label>

      <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save} disabled={busy || isRunning}>Save</button>
        {state.status !== "running" && state.status !== "starting" ? (
          <button className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? "Starting..." : "Start Worker"}
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stop} disabled={busy || state.status === "starting"}>Stop Worker</button>
        )}
      </div>

      {!state.cli_available && (
        <div style={{ marginTop: 12 }}>
          <div className="text-sm text-dim">Node.js is not available.</div>
          <button className="btn" onClick={install} disabled={busy} style={{ marginTop: 6 }}>
            {busy ? "Installing..." : "Install Node.js"}
          </button>
        </div>
      )}

      <p className="text-sm text-dim" style={{ marginTop: 14, lineHeight: 1.5 }}>
        在 Devin 网页端 设置 → Environment → Outposts 创建一个 Outpost，拿到 outpost_env ID 与 cog_ worker 令牌填入。
        RVM 会在本机运行 <code>devin worker start</code>，令牌仅存本机、不进日志。
      </p>

      {(state.error || message) && (
        <div className={`text-sm ${state.error ? "text-red" : "text-dim"}`} style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>
          {state.error || message}
        </div>
      )}

      <div className="card-header" style={{ marginTop: 16 }}>
        <span className="card-title">Worker Logs</span>
        <span className="text-sm text-dim">{logs.length} entries</span>
      </div>
      <div className="log-panel" ref={logRef} style={{ maxHeight: 220 }}>
        {logs.length === 0 ? "No logs yet." : logs.join("\n")}
      </div>
    </div>
  );
}

function ServerPanel(props: {
  config: AgentConfig;
  onChange: (c: AgentConfig) => void;
}) {
  const { config, onChange } = props;
  const [status, setStatus] = useState<Record<string, ServiceStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    invoke<Record<string, ServiceStatus>>("get_server_status")
      .then((s) => { if (s) setStatus(s); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const selected = new Set(config.auto_install || []);
  const anyUninstallable = SERVER_SERVICE_ORDER.some((id) => status[id]?.can_uninstall);

  const toggle = (id: string, installed: boolean) => {
    if (installed) return; // installed items are locked (checked + greyed)
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    const cfg = { ...config, auto_install: SERVER_SERVICE_ORDER.filter((s) => next.has(s)) };
    onChange(cfg);
    invoke("save_config", { config: cfg }).catch(() => {});
  };

  const installNow = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await invoke("install_service", { id }); } catch {}
    setBusy((b) => ({ ...b, [id]: false }));
    refresh();
  };

  const uninstallAll = async () => {
    if (!confirm("Uninstall all services that RVM installed? Pre-existing system installs are kept.")) return;
    setBusy((b) => ({ ...b, __all: true }));
    try { await invoke("uninstall_all_services"); } catch {}
    setBusy((b) => ({ ...b, __all: false }));
    refresh();
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Server Services</span>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={refresh}>Refresh</button>
          <button className="btn btn-danger" onClick={uninstallAll} disabled={!anyUninstallable || busy.__all}>
            {busy.__all ? "Uninstalling..." : "Uninstall RVM-installed"}
          </button>
        </div>
      </div>
      <p className="text-sm text-dim" style={{ marginBottom: 10 }}>
        Checked services are auto-installed when missing on start. Already-installed
        services are checked and locked. Only services installed by RVM
        can be uninstalled; pre-existing system installs are kept.
      </p>
      <div className="input-group" style={{ marginBottom: 10 }}>
        <label>GitHub 加速地址 (GitHub download mirror)</label>
        <input
          className="input"
          value={config.github_mirror}
          placeholder="https://gh-proxy.com/"
          onChange={(e) => {
            const cfg = { ...config, github_mirror: e.target.value };
            onChange(cfg);
          }}
          onBlur={() => { invoke("save_config", { config }).catch(() => {}); }}
        />
        <div className="text-dim" style={{ fontSize: 11, marginTop: 2 }}>
          加速 GitHub 下载。默认 https://gh-proxy.com/，留空则直连。
        </div>
      </div>
      {loading ? (
        <div className="text-sm text-dim">Detecting installed services...</div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {SERVER_SERVICE_ORDER.map((id) => {
            const s = status[id];
            const installed = !!s?.installed;
            const checked = installed || selected.has(id);
            const label = s?.name || id;
            let tag = "Not installed";
            let tagColor = "var(--text-dim)";
            if (installed && s?.source === "rvm") { tag = "Installed (RVM)"; tagColor = "var(--green)"; }
            else if (installed) { tag = "Installed (system)"; tagColor = "var(--green)"; }
            return (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={installed}
                  onChange={() => toggle(id, installed)}
                  style={installed ? { opacity: 0.5 } : undefined}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
                  {s?.detail && <div className="text-dim" style={{ fontSize: 11 }}>{s.detail}</div>}
                </div>
                <span style={{ fontSize: 12, color: tagColor, minWidth: 120, textAlign: "right" }}>{tag}</span>
                {!installed && (
                  <button className="btn" onClick={() => installNow(id)} disabled={!!busy[id]}>
                    {busy[id] ? "Installing..." : "Install"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type TabId = "status" | "config" | "server" | "capabilities" | "logs" | "outposts";

interface ServiceStatus {
  name: string;
  installed: boolean;
  detail: string;
  source: string; // "rvm" | "system" | ""
  can_uninstall: boolean;
}

const SERVER_SERVICE_ORDER = ["cloudflared", "novnc", "web_ide", "vnc_server", "ffmpeg", "git", "browser"];

export default function App() {
  const [state, setState] = useState<AgentState>(DEFAULT_STATE);
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [logs, setLogs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("status");
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
  const [installingNode, setInstallingNode] = useState(false);
  const [nodeMessage, setNodeMessage] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkNode = useCallback(() => {
    invoke<NodeStatus>("get_node_status")
      .then((s) => { if (s) setNodeStatus(s); })
      .catch(() => {});
  }, []);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    setLogs((prev) => [...prev.slice(-500), `[${ts}] ${msg}`]);
  }, []);

  // Load saved config on mount
  useEffect(() => {
    invoke<AgentConfig>("load_config").then((c) => {
      if (c) setConfig(c);
    }).catch(() => {});
    invoke<AgentState>("get_agent_state").then((s) => {
      if (s) setState(s);
    }).catch(() => {});
    checkNode();
  }, [checkNode]);

  const handleInstallNode = useCallback(async () => {
    setInstallingNode(true);
    setNodeMessage("正在下载并安装 Node.js…");
    try {
      const result = await invoke<string>("install_node");
      setNodeMessage(result || "Node.js 安装完成。");
      checkNode();
    } catch (e) {
      setNodeMessage(`安装失败: ${e}`);
    } finally {
      setInstallingNode(false);
    }
  }, [checkNode]);

  // Poll agent state and logs while running
  useEffect(() => {
    if (state.status === "running" || state.status === "starting") {
      pollRef.current = setInterval(() => {
        invoke<AgentState>("get_agent_state").then((s) => {
          if (s) {
            setState(s);
            if (s.status === "error" && s.error) {
              addLog(`ERROR: ${s.error}`);
            }
          }
        }).catch(() => {});
        invoke<string[]>("get_agent_logs").then((newLogs) => {
          if (newLogs && newLogs.length > 0) {
            setLogs(newLogs.slice(-500));
          }
        }).catch(() => {});
      }, 2000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [state.status, addLog]);

  const handleStart = useCallback(async () => {
    setState((s) => ({ ...s, status: "starting", error: "" }));
    addLog("Starting RVM agent...");
    try {
      const s = await invoke<AgentState>("start_agent", { config });
      setState(s);
      addLog(`Agent started on port ${s.port}`);
      if (s.direct_url) addLog(`Direct URL: ${s.direct_url}`);
      if (s.token) addLog(`Token: ${s.token.slice(0, 8)}...`);
    } catch (e) {
      const msg = String(e);
      setState((s) => ({ ...s, status: "error", error: msg }));
      addLog(`ERROR: ${msg}`);
    }
  }, [config, addLog]);

  const handleStop = useCallback(async () => {
    addLog("Stopping agent...");
    try {
      await invoke("stop_agent");
      setState(DEFAULT_STATE);
      addLog("Agent stopped.");
    } catch (e) {
      addLog(`Stop error: ${e}`);
    }
  }, [addLog]);

  const isRunning = state.status === "running" || state.status === "starting";

  const tabs: { id: TabId; label: string }[] = [
    { id: "status", label: "Status" },
    { id: "config", label: "Configuration" },
    { id: "server", label: "Server" },
    { id: "capabilities", label: "Capabilities" },
    { id: "logs", label: "Logs" },
    { id: "outposts", label: "Outposts" },
  ];

  return (
    <>
      <div className="titlebar">RVM (Remote Virtual Machines)</div>
      <div className="main">
        {/* Hero control */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          {!isRunning ? (
            <button className="btn btn-primary btn-lg" onClick={handleStart}>
              Enable Remote Dev
            </button>
          ) : (
            <button
              className="btn btn-danger btn-lg"
              onClick={handleStop}
              disabled={state.status === "starting"}
            >
              {state.status === "starting" ? "Starting..." : "Stop Remote Dev"}
            </button>
          )}
          <p className="text-sm text-dim mt-2">
            {isRunning
              ? "Agent is running. Cloud-Dev can connect via the URL below."
              : "Click to start the remote development host. Exposes this machine as a full Devin VM."}
          </p>
        </div>

        {/* Node.js runtime requirement */}
        {nodeStatus && !isRunning && (
          nodeStatus.available ? (
            <div className="text-sm text-dim" style={{ textAlign: "center", marginBottom: 16 }}>
              Node.js {nodeStatus.version}{nodeStatus.managed ? "（RVM 内置）" : ""} 就绪
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">
                <span className="card-title">需要 Node.js 运行时</span>
              </div>
              <p className="text-sm text-dim" style={{ lineHeight: 1.5 }}>
                RVM agent 需要 Node.js 才能运行。点击下方按钮，RVM 会自动下载官方 Node.js LTS 到本机（无需管理员权限），装好后即可启动。
              </p>
              <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" onClick={handleInstallNode} disabled={installingNode}>
                  {installingNode ? "安装中…" : "安装 Node.js"}
                </button>
                <button className="btn" onClick={checkNode} disabled={installingNode}>
                  重新检测
                </button>
              </div>
              {nodeMessage && (
                <div className="text-sm text-dim" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{nodeMessage}</div>
              )}
            </div>
          )
        )}

        {/* Tabs */}
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </div>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "status" && <StatusPanel state={state} />}
        {activeTab === "config" && (
          <ConfigPanel config={config} onChange={setConfig} disabled={isRunning} />
        )}
        {activeTab === "server" && <ServerPanel config={config} onChange={setConfig} />}
        {activeTab === "capabilities" && <CapabilitiesPanel state={state} />}
        {activeTab === "logs" && <LogPanel logs={logs} />}
        {activeTab === "outposts" && <OutpostsPanel />}
      </div>
    </>
  );
}

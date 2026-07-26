'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Terminal,
  Container,
  CheckCircle2,
  XCircle,
  Play,
  Square,
  Copy,
  Check,
  RefreshCw,
  Server,
  ShieldCheck,
  Cpu,
  Folder,
  Layers,
  Sparkles,
  Settings,
  Activity,
  Box,
  FileCode,
  ExternalLink,
  Power,
  Sliders,
  Wrench,
  Globe,
  Radio,
  FileText,
  KeyRound,
  Download,
  AlertCircle,
  Code,
  Zap,
  Info
} from 'lucide-react';

type TabId = 'status' | 'config' | 'server' | 'capabilities' | 'e2e' | 'terminal' | 'logs';

interface AgentState {
  status: 'stopped' | 'starting' | 'running' | 'error';
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
  services: Array<{ name: string; desc: string; installed: boolean; rvm: boolean }>;
  logs: string[];
}

interface AgentConfig {
  port: number;
  token: string;
  workspace: string;
  vnc_password: string;
  tunnel_mode: string;
  tunnel_protocol: string;
  cf_tunnel_token: string;
  public_url: string;
  bind_address: string;
  auto_install: string[];
  github_mirror: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  port: 9876,
  token: 'devin-rvm-secret-token',
  workspace: '/workspace',
  vnc_password: 'devin',
  tunnel_mode: 'auto',
  tunnel_protocol: 'http2',
  cf_tunnel_token: '',
  public_url: '',
  bind_address: '0.0.0.0',
  auto_install: ['cloudflared', 'novnc', 'web_ide', 'vnc_server', 'ffmpeg', 'git', 'browser'],
  github_mirror: 'https://gh-proxy.com/',
};

export default function RvmClientApp() {
  const [activeTab, setActiveTab] = useState<TabId>('status');
  const [state, setState] = useState<AgentState>({
    status: 'stopped',
    port: 9876,
    token: 'devin-rvm-secret-token',
    host: 'localhost',
    platform: 'linux',
    direct_url: 'http://localhost:9876',
    public_url: 'http://localhost:9876',
    vnc_port: 5900,
    cdp_port: 9222,
    pid: 0,
    error: '',
    workspace: '/workspace',
    capability_status: {},
    services: [],
    logs: [],
  });
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [agentBusy, setAgentBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // E2E Test Suite State
  const [e2eLoading, setE2eLoading] = useState(false);
  const [e2eResult, setE2eResult] = useState<{
    success?: boolean;
    exitCode?: number;
    output?: string;
    errorOutput?: string;
    timestamp?: string;
  } | null>(null);

  // MCP Interactive Tester State
  const [mcpMethod, setMcpMethod] = useState<'initialize' | 'tools/list' | 'system_info' | 'shell_exec' | 'read_file'>('system_info');
  const [mcpResult, setMcpResult] = useState<string>('');
  const [mcpLoading, setMcpLoading] = useState(false);

  // Shell Console State
  const [command, setCommand] = useState('node ./rvm/agent/test.js');
  const [execLoading, setExecLoading] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<Array<{ cmd: string; out: string; err?: string; time: string }>>([]);

  // Server Installation State
  const [installingService, setInstallingService] = useState<string | null>(null);
  const [installingAll, setInstallingAll] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);

  const handleInstallService = async (serviceName: string) => {
    setInstallingService(serviceName);
    try {
      await fetch('/api/rvm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install_service', service: serviceName }),
      });
      await fetchState();
    } catch (err) {
      console.error(err);
    } finally {
      setInstallingService(null);
    }
  };

  const handleInstallAllServices = async () => {
    setInstallingAll(true);
    try {
      await fetch('/api/rvm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install_all_services' }),
      });
      await fetchState();
    } catch (err) {
      console.error(err);
    } finally {
      setInstallingAll(false);
    }
  };

  // Fetch Agent State
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/rvm');
      const data = await res.json();
      if (data) {
        setState((prev) => ({
          ...prev,
          status: data.status,
          pid: data.pid,
          port: data.port,
          token: data.token,
          direct_url: data.direct_url,
          public_url: data.public_url,
          workspace: data.workspace,
          logs: data.logs || [],
          capability_status: data.capability_status || {},
          services: data.services || [],
        }));
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 3000);
    return () => clearInterval(interval);
  }, [fetchState]);

  // Run E2E test suite automatically once
  const runE2ETests = async () => {
    setE2eLoading(true);
    try {
      const res = await fetch('/api/test-rvm', { method: 'POST' });
      const data = await res.json();
      setE2eResult(data);
    } catch (err: any) {
      setE2eResult({
        success: false,
        exitCode: -1,
        output: '',
        errorOutput: err.message || 'Network error running E2E tests',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setE2eLoading(false);
    }
  };

  useEffect(() => {
    runE2ETests();
  }, []);

  // Enable or Stop Remote Dev Agent
  const handleToggleAgent = async () => {
    setAgentBusy(true);
    const action = state.status === 'running' ? 'stop' : 'start';
    try {
      const res = await fetch('/api/rvm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, config }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchState();
      }
    } catch {} finally {
      setAgentBusy(false);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  // Run MCP tool call
  const handleMcpCall = async (toolName?: string) => {
    setMcpLoading(true);
    setMcpResult('');
    try {
      let reqBody: any = {};
      if (toolName === 'initialize' || mcpMethod === 'initialize') {
        reqBody = { action: 'mcp_call', method: 'initialize', params: {} };
      } else if (toolName === 'tools/list' || mcpMethod === 'tools/list') {
        reqBody = { action: 'mcp_call', method: 'tools/list', params: {} };
      } else if (toolName === 'system_info' || mcpMethod === 'system_info') {
        reqBody = {
          action: 'mcp_call',
          method: 'tools/call',
          params: { name: 'system_info', arguments: {} },
        };
      } else if (toolName === 'shell_exec' || mcpMethod === 'shell_exec') {
        reqBody = {
          action: 'mcp_call',
          method: 'tools/call',
          params: { name: 'shell_exec', arguments: { command: 'echo "MCP_E2E_REAL_TEST_SUCCESS"' } },
        };
      } else if (toolName === 'read_file' || mcpMethod === 'read_file') {
        reqBody = {
          action: 'mcp_call',
          method: 'tools/call',
          params: { name: 'read_file', arguments: { path: '/app/applet/package.json' } },
        };
      }

      const res = await fetch('/api/rvm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      const data = await res.json();
      setMcpResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setMcpResult(`MCP Call Error: ${err.message || err}`);
    } finally {
      setMcpLoading(false);
    }
  };

  // Shell command execution
  const handleExec = async (cmdToRun?: string) => {
    const targetCmd = cmdToRun || command;
    if (!targetCmd.trim()) return;
    setExecLoading(true);

    try {
      const res = await fetch('/api/rvm-exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: targetCmd }),
      });
      const data = await res.json();
      setConsoleLogs((prev) => [
        {
          cmd: targetCmd,
          out: data.stdout || data.error || 'Done',
          err: data.stderr,
          time: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);
    } catch (err: any) {
      setConsoleLogs((prev) => [
        {
          cmd: targetCmd,
          out: '',
          err: err.message || 'Execution error',
          time: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);
    } finally {
      setExecLoading(false);
    }
  };

  const capabilitiesList = [
    { id: 'shell_execution', name: 'Shell Execution', desc: 'exec, write_to_process (interactive PTY)' },
    { id: 'file_system', name: 'File System', desc: 'read, write, edit, multi_edit, glob, grep, search, list_dir, upload, download' },
    { id: 'computer_use', name: 'Computer Use', desc: 'screenshot, click, type, key, scroll, move, resolution' },
    { id: 'browser_cdp', name: 'Browser (CDP)', desc: 'Chrome DevTools Protocol proxy, inject cookies, navigate' },
    { id: 'vnc_desktop', name: 'VNC Desktop', desc: 'WebSocket VNC proxy at /vnc-ws' },
    { id: 'novnc_web_client', name: 'noVNC Web Client', desc: 'Browser-based VNC at /novnc/ (auto-download)' },
    { id: 'web_ide', name: 'Web IDE (code-server)', desc: 'VS Code in browser at /ide/ (auto-install)' },
    { id: 'pty_terminal', name: 'PTY Terminal', desc: 'Interactive pseudo-terminal via /pty-ws' },
    { id: 'cdp_browser', name: 'CDP Browser', desc: 'Chrome DevTools Protocol proxy at /cdp-ws' },
    { id: 'git_operations', name: 'Git Operations', desc: 'clone, pull, push, status, diff, checkout, log, branch, merge, rebase' },
    { id: 'port_forwarding', name: 'Port Forwarding', desc: 'Expose local ports via cloudflare tunnel' },
    { id: 'mcp_server', name: 'MCP Server', desc: 'JSON-RPC MCP endpoint at /mcp (Streamable HTTP)' },
    { id: 'repo_setup', name: 'Repo Setup', desc: 'Clone repo, auto-detect stack, install deps, build' },
    { id: 'code_scanning', name: 'Code Scanning', desc: 'Pattern matching, security scanning' },
    { id: 'deploy_support', name: 'Deploy Support', desc: 'ZIP upload, extraction, project deployment' },
    { id: 'storage', name: 'Storage', desc: 'Binary upload/download, stat, copy, rename, hash' },
    { id: 'middleware', name: 'Middleware', desc: 'Pre/post tool hooks, session lifecycle' },
    { id: 'event_handling', name: 'Event Handling', desc: 'Subscribe to remote events' },
    { id: 'scratchpad', name: 'Scratchpad', desc: 'Temporary workspace, key-value store' },
    { id: 'recording', name: 'Recording', desc: 'Screen recording start/stop (ffmpeg)' },
    { id: 'notebook', name: 'Notebook', desc: 'Jupyter .ipynb reading with cell outputs' },
  ];

  const endpointBase = state.public_url || state.direct_url;
  const wsBase = endpointBase.replace(/^http/i, 'ws');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans antialiased">
      {/* RVM Client Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-3.5">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0">
              <Box className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <h1 className="text-xl font-bold tracking-tight text-white">RVM Client</h1>
                <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-slate-800 border border-slate-700 text-slate-300">
                  Remote Virtual Machines
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Devin Remote Virtual Host Manager, MCP Server & Live E2E Integration Environment
              </p>
            </div>
          </div>

          {/* Hero Remote Dev Toggle */}
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
              <div className={`w-2 h-2 rounded-full ${state.status === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
              <span className="font-mono text-slate-300 capitalize">{state.status}</span>
              {state.pid > 0 && <span className="text-slate-500">PID {state.pid}</span>}
            </div>

            <button
              onClick={handleToggleAgent}
              disabled={agentBusy}
              className={`inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl text-xs font-semibold shadow-lg transition active:scale-95 disabled:opacity-50 ${
                state.status === 'running'
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/40'
                  : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-950/40'
              }`}
            >
              <Power className={`w-4 h-4 ${agentBusy ? 'animate-spin' : ''}`} />
              <span>{state.status === 'running' ? 'Stop Remote Dev' : 'Enable Remote Dev'}</span>
            </button>
          </div>
        </div>

        {/* Client Navigation Tabs */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-slate-800/80 flex space-x-1 overflow-x-auto">
          {[
            { id: 'status', label: 'Status', icon: Activity },
            { id: 'config', label: 'Configuration', icon: Sliders },
            { id: 'server', label: 'Server Services', icon: Server },
            { id: 'capabilities', label: 'Capabilities', icon: Cpu },
            { id: 'e2e', label: 'MCP & API Testing', icon: ShieldCheck },
            { id: 'terminal', label: 'Terminal', icon: Terminal },
            { id: 'logs', label: 'Logs', icon: FileText },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center space-x-2 px-4 py-3 text-xs font-medium border-b-2 transition whitespace-nowrap ${
                  isActive
                    ? 'border-cyan-400 text-cyan-400 bg-cyan-500/5'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Client Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* TAB 1: STATUS PANEL */}
        {activeTab === 'status' && (
          <div className="space-y-6">
            {/* Direct & Public URLs Info Grid */}
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center space-x-2.5">
                  <Globe className="w-5 h-5 text-cyan-400" />
                  <h2 className="text-base font-semibold text-white">RVM Remote Machine Endpoints</h2>
                </div>
                <span className="text-xs text-slate-400">Linux x64 (Remote Dev Host)</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="text-slate-400 font-sans font-medium flex items-center justify-between">
                    <span>Direct URL</span>
                    <button
                      onClick={() => copyToClipboard(state.direct_url, 'direct_url')}
                      className="text-slate-400 hover:text-white transition"
                    >
                      {copiedKey === 'direct_url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <div className="text-cyan-300 font-bold text-sm truncate">{state.direct_url}</div>
                </div>

                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="text-slate-400 font-sans font-medium flex items-center justify-between">
                    <div className="flex items-center space-x-1.5">
                      <span>Public URL</span>
                      {state.public_url && state.public_url !== state.direct_url ? (
                        <span className="px-1.5 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded font-semibold">Tunnel Live</span>
                      ) : (
                        <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded font-semibold">Local Only</span>
                      )}
                    </div>
                    <button
                      onClick={() => copyToClipboard(state.public_url || state.direct_url, 'public_url')}
                      className="text-slate-400 hover:text-white transition"
                    >
                      {copiedKey === 'public_url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <div className="text-emerald-300 font-bold text-sm truncate">{state.public_url || state.direct_url}</div>
                </div>

                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="text-slate-400 font-sans font-medium flex items-center justify-between">
                    <span>Token</span>
                    <button
                      onClick={() => copyToClipboard(state.token, 'token')}
                      className="text-slate-400 hover:text-white transition"
                    >
                      {copiedKey === 'token' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <div className="text-amber-300 font-bold text-sm truncate">{state.token}</div>
                </div>
              </div>

              {/* Endpoints Table */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-300 font-sans uppercase tracking-wider">
                  Public & Local Exposed Endpoint Surfaces:
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                  {[
                    { label: 'REST API', url: `${endpointBase}/api/`, key: 'ep_api' },
                    { label: 'MCP JSON-RPC', url: `${endpointBase}/mcp`, key: 'ep_mcp' },
                    { label: 'VNC WebSocket', url: `${wsBase}/vnc-ws`, key: 'ep_vnc' },
                    { label: 'PTY Terminal WS', url: `${wsBase}/pty-ws`, key: 'ep_pty' },
                    { label: 'CDP Browser WS', url: `${wsBase}/cdp-ws`, key: 'ep_cdp' },
                    { label: 'noVNC Client', url: `${endpointBase}/novnc/`, key: 'ep_novnc' },
                    { label: 'Web IDE', url: `${endpointBase}/ide/?tkn=${encodeURIComponent(state.token)}`, key: 'ep_ide' },
                    { label: 'Capabilities', url: `${endpointBase}/api/capabilities`, key: 'ep_cap' },
                  ].map((item) => (
                    <div key={item.key} className="p-3 rounded-lg bg-slate-950 border border-slate-800/80 flex items-center justify-between">
                      <div className="truncate mr-2">
                        <div className="text-slate-400 text-[11px]">{item.label}</div>
                        <div className="text-slate-200 font-mono text-[11px] truncate mt-0.5">{item.url}</div>
                      </div>
                      <button
                        onClick={() => copyToClipboard(item.url, item.key)}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
                      >
                        {copiedKey === item.key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: CONFIGURATION */}
        {activeTab === 'config' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-6">
            <div className="flex items-center space-x-2 border-b border-slate-800 pb-4">
              <Sliders className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">RVM Agent Configuration</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
              <div className="space-y-2">
                <label className="text-slate-300 font-semibold">Port</label>
                <input
                  type="number"
                  value={config.port}
                  onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 9876 })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 font-mono text-slate-100 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-semibold">Token (Leave empty for auto-generate)</label>
                <input
                  type="text"
                  value={config.token}
                  onChange={(e) => setConfig({ ...config, token: e.target.value })}
                  placeholder="Auto-generated"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 font-mono text-slate-100 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-semibold">Workspace Root</label>
                <input
                  type="text"
                  value={config.workspace}
                  onChange={(e) => setConfig({ ...config, workspace: e.target.value })}
                  placeholder="/workspace"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 font-mono text-slate-100 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-semibold">VNC Password</label>
                <input
                  type="text"
                  value={config.vnc_password}
                  onChange={(e) => setConfig({ ...config, vnc_password: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 font-mono text-slate-100 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-semibold">Tunnel Mode</label>
                <select
                  value={config.tunnel_mode}
                  onChange={(e) => setConfig({ ...config, tunnel_mode: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-slate-100 focus:outline-none focus:border-cyan-500 transition"
                >
                  <option value="auto">Auto (Quick Tunnel)</option>
                  <option value="off">Off</option>
                  <option value="named">Named Tunnel (Cloudflare Token)</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-semibold">Tunnel Protocol</label>
                <select
                  value={config.tunnel_protocol}
                  onChange={(e) => setConfig({ ...config, tunnel_protocol: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-slate-100 focus:outline-none focus:border-cyan-500 transition"
                >
                  <option value="http2">HTTP/2 (TCP, recommended)</option>
                  <option value="quic">QUIC (UDP)</option>
                  <option value="auto">Auto (cloudflared default)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: SERVER SERVICES */}
        {activeTab === 'server' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="flex items-center space-x-2">
                <Server className="w-5 h-5 text-cyan-400" />
                <div>
                  <h2 className="text-base font-semibold text-white">RVM Server 依赖与服务列表 (真实检测)</h2>
                  <p className="text-xs text-slate-400 mt-0.5">实时检测 Linux 宿主机基础软件与 CLI 依赖状态</p>
                </div>
              </div>
              <div className="flex items-center space-x-2.5">
                <button
                  onClick={handleInstallAllServices}
                  disabled={installingAll || installingService !== null}
                  className="px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold text-xs transition flex items-center space-x-1.5 shadow"
                >
                  {installingAll ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Wrench className="w-3.5 h-3.5" />
                  )}
                  <span>一键安装缺少的服务</span>
                </button>
                <button
                  onClick={fetchState}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs transition flex items-center space-x-1"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>重新检测</span>
                </button>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              {(state.services.length > 0
                ? state.services
                : [
                    { name: 'cloudflared', desc: 'Cloudflare Tunnel for public HTTP/WS routing', installed: false, rvm: true },
                    { name: 'novnc', desc: 'Browser-based VNC desktop client', installed: false, rvm: true },
                    { name: 'web_ide', desc: 'VS Code in Browser (code-server)', installed: false, rvm: true },
                    { name: 'vnc_server', desc: 'Xvfb + x11vnc virtual display server', installed: false, rvm: true },
                    { name: 'ffmpeg', desc: 'Screen recording & video streaming audio/video tools', installed: false, rvm: true },
                    { name: 'git', desc: 'Git version control system', installed: false, rvm: false },
                    { name: 'browser', desc: 'Headless Chromium browser for CDP', installed: false, rvm: true },
                  ]
              ).map((svc) => (
                <div key={svc.name} className="p-4 rounded-lg bg-slate-950 border border-slate-800/90 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start space-x-3">
                    {svc.installed ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-slate-200 text-sm">{svc.name}</span>
                        {svc.rvm && <span className="px-1.5 py-0.2 text-[10px] bg-slate-800 text-cyan-300 rounded border border-slate-700 font-mono">RVM Core</span>}
                      </div>
                      <p className="text-slate-400 text-xs mt-0.5">{svc.desc}</p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 self-end sm:self-center shrink-0">
                    <span
                      className={`px-2.5 py-1 text-[11px] font-mono rounded border ${
                        svc.installed
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                      }`}
                    >
                      {svc.installed ? `已安装 (${svc.rvm ? 'RVM' : '系统'})` : '未安装'}
                    </span>

                    {!svc.installed && (
                      <button
                        onClick={() => handleInstallService(svc.name)}
                        disabled={installingService === svc.name || installingAll}
                        className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 hover:text-cyan-200 border border-slate-700 text-xs font-medium transition flex items-center space-x-1"
                      >
                        {installingService === svc.name ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            <span>安装中...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3" />
                            <span>一键安装</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: CAPABILITIES */}
        {activeTab === 'capabilities' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="flex items-center space-x-2">
                <Cpu className="w-5 h-5 text-cyan-400" />
                <div>
                  <h2 className="text-base font-semibold text-white">VM Capabilities Matrix (devin-remote 兼容 - 真实检测结果)</h2>
                  <p className="text-xs text-slate-400 mt-0.5">根据 Agent 运行状态与宿主机依赖进行实时检测与能力就绪性验证</p>
                </div>
              </div>
              <div className="flex items-center space-x-2.5">
                <button
                  onClick={fetchState}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs transition flex items-center space-x-1"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>刷新真实检测</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 text-xs">
              {capabilitiesList.map((c) => {
                const status = state.capability_status[c.id] || (state.status === 'running' ? 'ok' : 'offline');

                let badge = { text: '正常 / Active', cls: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' };
                if (status === 'missing_dependency') {
                  badge = { text: '依赖缺失', cls: 'bg-amber-500/10 border-amber-500/30 text-amber-400' };
                } else if (status === 'offline') {
                  badge = { text: 'Agent 未启动', cls: 'bg-slate-800/80 border-slate-700 text-slate-400' };
                } else if (status === 'limited') {
                  badge = { text: '受限 / Limited', cls: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' };
                } else if (status === 'error') {
                  badge = { text: '异常 / Error', cls: 'bg-rose-500/10 border-rose-500/30 text-rose-400' };
                }

                return (
                  <div key={c.id} className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 flex flex-col justify-between space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-200 text-xs">{c.name}</span>
                        <span className={`px-2 py-0.5 text-[10px] font-mono rounded border ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </div>
                      <p className="text-slate-400 text-[11px] leading-relaxed">{c.desc}</p>
                    </div>

                    {status === 'missing_dependency' && (
                      <div className="text-[10px] text-amber-400/90 bg-amber-950/30 p-1.5 rounded border border-amber-800/40 flex items-center justify-between">
                        <span>缺少环境依赖软件</span>
                        <button
                          onClick={() => setActiveTab('server')}
                          className="underline hover:text-amber-200"
                        >
                          前往安装
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 5: E2E MCP & API TESTING */}
        {activeTab === 'e2e' && (
          <div className="space-y-6">
            {/* Live E2E Automated Test Suite Header */}
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-6 shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div className="flex items-center space-x-3">
                  <ShieldCheck className="w-6 h-6 text-cyan-400" />
                  <div>
                    <h2 className="text-base font-semibold text-white">真实 E2E 自动化测试 & MCP 协议验证 (Real E2E Runner)</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      实际向运行中的 RVM Agent 端口发起真实 HTTP & MCP JSON-RPC 请求并断言结果
                    </p>
                  </div>
                </div>

                <button
                  onClick={runE2ETests}
                  disabled={e2eLoading}
                  className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs transition shadow-lg shadow-cyan-950/40 active:scale-95 disabled:opacity-50 shrink-0"
                >
                  <Play className={`w-4 h-4 ${e2eLoading ? 'animate-spin' : ''}`} />
                  <span>{e2eLoading ? '正在运行真实 E2E...' : '运行真实 E2E 测试套件'}</span>
                </button>
              </div>

              {/* Test Log Output Box */}
              <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs max-h-[380px] overflow-y-auto leading-relaxed">
                {e2eLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 text-slate-400 space-y-3">
                    <RefreshCw className="w-8 h-8 animate-spin text-cyan-400" />
                    <p className="text-sm">正在发起真实的网络 E2E HTTP / MCP JSON-RPC 请求测试...</p>
                  </div>
                ) : e2eResult?.output ? (
                  <pre className="whitespace-pre-wrap text-slate-200">
                    {e2eResult.output.split('\n').map((line, idx) => {
                      if (line.includes('✓ PASSED')) {
                        return <span key={idx} className="text-emerald-400 font-semibold">{line}{'\n'}</span>;
                      }
                      if (line.includes('✗ FAILED')) {
                        return <span key={idx} className="text-rose-400 font-bold">{line}{'\n'}</span>;
                      }
                      if (line.includes('===') || line.includes('Starting')) {
                        return <span key={idx} className="text-cyan-300 font-bold">{line}{'\n'}</span>;
                      }
                      if (line.includes('Testing')) {
                        return <span key={idx} className="text-amber-300 font-medium">{line}{'\n'}</span>;
                      }
                      return <span key={idx}>{line}{'\n'}</span>;
                    })}
                  </pre>
                ) : (
                  <div className="text-slate-500 italic py-8 text-center">点击右上角按钮以执行真实 E2E 测试</div>
                )}
              </div>
            </div>

            {/* Interactive MCP JSON-RPC Client Inspector */}
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 shadow-xl">
              <div className="flex items-center space-x-2 border-b border-slate-800 pb-3">
                <Code className="w-5 h-5 text-purple-400" />
                <h3 className="text-sm font-semibold text-white">MCP Streamable HTTP JSON-RPC 交互式调测 (/mcp)</h3>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {[
                  { label: 'initialize', name: 'initialize' },
                  { label: 'tools/list', name: 'tools/list' },
                  { label: 'tools/call (system_info)', name: 'system_info' },
                  { label: 'tools/call (shell_exec)', name: 'shell_exec' },
                  { label: 'tools/call (read_file)', name: 'read_file' },
                ].map((item) => (
                  <button
                    key={item.name}
                    onClick={() => {
                      setMcpMethod(item.name as any);
                      handleMcpCall(item.name);
                    }}
                    className="px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center space-x-1.5"
                  >
                    <Zap className="w-3 h-3 text-cyan-400" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>

              {mcpResult && (
                <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs overflow-x-auto max-h-[300px]">
                  <pre className="text-cyan-100/90 leading-relaxed">{mcpResult}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 7: INTERACTIVE TERMINAL */}
        {activeTab === 'terminal' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Terminal className="w-5 h-5 text-cyan-400" />
                <h2 className="text-sm font-semibold text-slate-200">交互式 Shell 命令行 (RVM Exec Console)</h2>
              </div>
            </div>

            <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center space-x-3">
              <span className="text-cyan-400 font-mono text-sm font-bold">$</span>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleExec()}
                placeholder="输入命令..."
                className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition"
              />
              <button
                onClick={() => handleExec()}
                disabled={execLoading}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs transition flex items-center space-x-1.5 shrink-0"
              >
                {execLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                <span>执行</span>
              </button>
            </div>

            <div className="p-5 font-mono text-xs bg-slate-950 min-h-[360px] max-h-[500px] overflow-y-auto space-y-4">
              {consoleLogs.length === 0 ? (
                <div className="text-slate-500 text-center py-16 italic">输入命令并回车或点击“执行”</div>
              ) : (
                consoleLogs.map((logItem, idx) => (
                  <div key={idx} className="p-3.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between text-slate-400 text-[11px] pb-1 border-b border-slate-800/60">
                      <span className="text-cyan-300 font-bold">$ {logItem.cmd}</span>
                      <span>{logItem.time}</span>
                    </div>
                    <pre className="text-slate-200 whitespace-pre-wrap leading-relaxed">{logItem.out}</pre>
                    {logItem.err && <pre className="text-rose-400 whitespace-pre-wrap leading-relaxed">{logItem.err}</pre>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TAB 8: CLIENT LOGS */}
        {activeTab === 'logs' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <FileText className="w-5 h-5 text-cyan-400" />
                <h2 className="text-sm font-semibold text-slate-200">RVM Agent 运行日志 Stream</h2>
              </div>
              <span className="text-xs text-slate-400">{state.logs.length} entries</span>
            </div>

            <div ref={logRef} className="p-5 font-mono text-xs bg-slate-950 max-h-[500px] overflow-y-auto leading-relaxed">
              {state.logs.length === 0 ? (
                <div className="text-slate-500 italic py-12 text-center">暂无 Agent 运行日志</div>
              ) : (
                <pre className="text-slate-300 whitespace-pre-wrap">{state.logs.join('\n')}</pre>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

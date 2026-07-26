import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
import { spawn, ChildProcess, execSync, exec } from 'child_process';
import path from 'path';
import http from 'http';
import fs from 'fs';

const g = globalThis as any;
if (!g.__rvm_agent_logs) g.__rvm_agent_logs = [];
if (!g.__rvm_agent_config) {
  g.__rvm_agent_config = {
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
}

let agentLogs: string[] = g.__rvm_agent_logs;
let agentConfig = g.__rvm_agent_config;

function getAgentProcess(): ChildProcess | null {
  return g.__rvm_agent_process || null;
}

function setAgentProcess(proc: ChildProcess | null) {
  g.__rvm_agent_process = proc;
}

function checkWhich(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkBinaryInstalled(binName: string): boolean {
  try {
    if (binName === 'cloudflared') {
      return (
        fs.existsSync('/root/.cloud-dev/cloudflared') ||
        fs.existsSync('/usr/local/bin/cloudflared') ||
        fs.existsSync('/usr/bin/cloudflared') ||
        fs.existsSync(path.join(process.cwd(), 'rvm', 'agent', 'cloudflared')) ||
        checkWhich('cloudflared')
      );
    }
    if (binName === 'novnc') {
      return (
        fs.existsSync('/root/.rvm/novnc') ||
        fs.existsSync('/usr/share/novnc') ||
        fs.existsSync(path.join(process.cwd(), 'rvm', 'agent', 'novnc'))
      );
    }
    if (binName === 'web_ide') {
      return (
        fs.existsSync('/root/.rvm/vscode-cli/code') ||
        fs.existsSync('/root/.rvm/vscode-cli') ||
        fs.existsSync('/root/.rvm/code-server') ||
        fs.existsSync('/root/.local/bin/code-server') ||
        fs.existsSync('/root/.local/lib/code-server') ||
        fs.existsSync('/usr/lib/code-server') ||
        fs.existsSync('/usr/bin/code-server') ||
        fs.existsSync('/usr/local/bin/code-server') ||
        fs.existsSync(path.join(process.cwd(), 'rvm', 'agent', 'ide')) ||
        checkWhich('code-server') ||
        checkWhich('code')
      );
    }
    if (binName === 'vnc_server') {
      return (
        (fs.existsSync('/usr/bin/x11vnc') || checkWhich('x11vnc')) &&
        (fs.existsSync('/usr/bin/Xvfb') || checkWhich('Xvfb'))
      );
    }
    if (binName === 'ffmpeg') {
      return fs.existsSync('/usr/bin/ffmpeg') || checkWhich('ffmpeg');
    }
    if (binName === 'git') {
      return fs.existsSync('/usr/bin/git') || checkWhich('git');
    }
    if (binName === 'browser') {
      return (
        fs.existsSync('/usr/bin/chromium') ||
        fs.existsSync('/usr/bin/chromium-browser') ||
        fs.existsSync('/usr/bin/google-chrome') ||
        checkWhich('chromium') ||
        checkWhich('chromium-browser') ||
        checkWhich('google-chrome')
      );
    }
    return checkWhich(binName);
  } catch {
    return false;
  }
}

async function runInstallCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    addLog(`[install] Running command: ${cmd}`);
    exec(cmd, { env: process.env }, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) addLog(`[install:stdout] ${stdout.trim().slice(-300)}`);
      if (stderr && stderr.trim()) addLog(`[install:stderr] ${stderr.trim().slice(-300)}`);
      if (err) {
        addLog(`[install:error] ${err.message}`);
        reject(err);
      } else {
        addLog(`[install:success] Command completed: ${cmd}`);
        resolve(stdout);
      }
    });
  });
}

function dynamicRequire(filePath: string) {
  const req = eval('require');
  return req(filePath);
}

async function installService(serviceName: string): Promise<boolean> {
  addLog(`[install] Starting installation for service: ${serviceName}`);
  try {
    const installerPath = path.join(process.cwd(), 'rvm', 'agent', 'installer.js');
    if (fs.existsSync(installerPath)) {
      const installer = dynamicRequire(installerPath);
      if (typeof installer.install === 'function') {
        addLog(`[install] Invoking RVM installer.install('${serviceName}')`);
        const ok = await installer.install(serviceName);
        addLog(`[install] RVM installer result for ${serviceName}: ${ok}`);
        if (ok) return true;
      }
    }
  } catch (err: any) {
    addLog(`[install] RVM installer module error: ${err.message}`);
  }

  try {
    switch (serviceName) {
      case 'cloudflared':
        await runInstallCmd('mkdir -p /root/.cloud-dev && curl -L -o /root/.cloud-dev/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /root/.cloud-dev/cloudflared');
        break;
      case 'novnc':
        await runInstallCmd('mkdir -p /root/.rvm && (git clone https://github.com/novnc/noVNC.git /root/.rvm/novnc 2>/dev/null || (cd /root/.rvm/novnc && git pull))');
        break;
      case 'web_ide':
        await runInstallCmd('mkdir -p /root/.rvm/vscode-cli && curl -fL "https://github.com/devin-ai/vscode-dist/releases/latest/download/devin-cli-linux-x64.tar.gz" -o "/root/.rvm/vscode-cli/devin-cli-linux-x64.tar.gz" && tar xzf "/root/.rvm/vscode-cli/devin-cli-linux-x64.tar.gz" -C "/root/.rvm/vscode-cli" && chmod +x "/root/.rvm/vscode-cli/code"');
        break;
      case 'vnc_server':
        await runInstallCmd('apt-get update && apt-get install -y xvfb x11vnc');
        break;
      case 'ffmpeg':
        await runInstallCmd('apt-get update && apt-get install -y ffmpeg');
        break;
      case 'git':
        await runInstallCmd('apt-get update && apt-get install -y git');
        break;
      case 'browser':
        await runInstallCmd('apt-get update && (apt-get install -y chromium-browser || apt-get install -y chromium || apt-get install -y google-chrome-stable)');
        break;
      default:
        throw new Error(`Unknown service name: ${serviceName}`);
    }
    addLog(`[install] Service ${serviceName} installed successfully.`);
    return true;
  } catch (err: any) {
    addLog(`[install] Failed installing ${serviceName}: ${err.message || err}`);
    return false;
  }
}

function getServerServicesStatus() {
  try {
    const installerPath = path.join(process.cwd(), 'rvm', 'agent', 'installer.js');
    if (fs.existsSync(installerPath)) {
      const installer = dynamicRequire(installerPath);
      const st = installer.status();
      const svcDescs: Record<string, { desc: string; rvm: boolean }> = {
        cloudflared: { desc: 'Cloudflare Tunnel for public HTTP/WS routing', rvm: true },
        novnc: { desc: 'Browser-based VNC desktop client', rvm: true },
        web_ide: { desc: 'VS Code in Browser (code-server / Devin CLI)', rvm: true },
        vnc_server: { desc: 'Xvfb + x11vnc virtual display server', rvm: true },
        ffmpeg: { desc: 'Screen recording & video streaming audio/video tools', rvm: true },
        git: { desc: 'Git version control system', rvm: false },
        browser: { desc: 'Headless Chromium browser for CDP', rvm: true },
      };

      return Object.keys(svcDescs).map((name) => {
        const item = st[name];
        const fallbackInstalled = checkBinaryInstalled(name);
        const installed = item ? !!item.installed : fallbackInstalled;
        const source = item?.source || (installed ? (svcDescs[name].rvm ? 'rvm' : 'system') : '');
        return {
          name,
          desc: svcDescs[name].desc,
          installed,
          rvm: source === 'rvm' || svcDescs[name].rvm,
          detail: item?.detail || '',
        };
      });
    }
  } catch (err) {
    // fallback
  }

  return [
    { name: 'cloudflared', desc: 'Cloudflare Tunnel for public HTTP/WS routing', installed: checkBinaryInstalled('cloudflared'), rvm: true, detail: '' },
    { name: 'novnc', desc: 'Browser-based VNC desktop client', installed: checkBinaryInstalled('novnc'), rvm: true, detail: '' },
    { name: 'web_ide', desc: 'VS Code in Browser (code-server)', installed: checkBinaryInstalled('web_ide'), rvm: true, detail: '' },
    { name: 'vnc_server', desc: 'Xvfb + x11vnc virtual display server', installed: checkBinaryInstalled('vnc_server'), rvm: true, detail: '' },
    { name: 'ffmpeg', desc: 'Screen recording & video streaming audio/video tools', installed: checkBinaryInstalled('ffmpeg'), rvm: true, detail: '' },
    { name: 'git', desc: 'Git version control system', installed: checkBinaryInstalled('git'), rvm: false, detail: '' },
    { name: 'browser', desc: 'Headless Chromium browser for CDP', installed: checkBinaryInstalled('browser'), rvm: true, detail: '' },
  ];
}

function computeRealCapabilities(isHealthy: boolean, servicesStatus: Array<{ name: string; installed: boolean }>) {
  const getSvcInstalled = (name: string) => servicesStatus.find(s => s.name === name)?.installed ?? false;

  const cloudflaredOk = getSvcInstalled('cloudflared');
  const novncOk = getSvcInstalled('novnc');
  const webIdeOk = getSvcInstalled('web_ide');
  const vncServerOk = getSvcInstalled('vnc_server');
  const ffmpegOk = getSvcInstalled('ffmpeg');
  const gitOk = getSvcInstalled('git');
  const browserOk = getSvcInstalled('browser');

  if (!isHealthy) {
    return {
      shell_execution: 'offline',
      file_system: 'offline',
      computer_use: (vncServerOk && browserOk) ? 'offline' : 'missing_dependency',
      browser_cdp: browserOk ? 'offline' : 'missing_dependency',
      vnc_desktop: vncServerOk ? 'offline' : 'missing_dependency',
      novnc_web_client: novncOk ? 'offline' : 'missing_dependency',
      web_ide: webIdeOk ? 'offline' : 'missing_dependency',
      pty_terminal: 'offline',
      cdp_browser: browserOk ? 'offline' : 'missing_dependency',
      git_operations: gitOk ? 'offline' : 'missing_dependency',
      port_forwarding: cloudflaredOk ? 'offline' : 'missing_dependency',
      mcp_server: 'offline',
      repo_setup: gitOk ? 'offline' : 'missing_dependency',
      code_scanning: 'offline',
      deploy_support: 'offline',
      storage: 'offline',
      middleware: 'offline',
      event_handling: 'offline',
      scratchpad: 'offline',
      recording: ffmpegOk ? 'offline' : 'missing_dependency',
      notebook: 'offline',
    };
  }

  return {
    shell_execution: 'ok',
    file_system: 'ok',
    computer_use: (vncServerOk && browserOk) ? 'ok' : 'missing_dependency',
    browser_cdp: browserOk ? 'ok' : 'missing_dependency',
    vnc_desktop: vncServerOk ? 'ok' : 'missing_dependency',
    novnc_web_client: novncOk ? 'ok' : 'missing_dependency',
    web_ide: webIdeOk ? 'ok' : 'missing_dependency',
    pty_terminal: 'ok',
    cdp_browser: browserOk ? 'ok' : 'missing_dependency',
    git_operations: gitOk ? 'ok' : 'missing_dependency',
    port_forwarding: cloudflaredOk ? 'ok' : 'limited',
    mcp_server: 'ok',
    repo_setup: gitOk ? 'ok' : 'missing_dependency',
    code_scanning: 'ok',
    deploy_support: 'ok',
    storage: 'ok',
    middleware: 'ok',
    event_handling: 'ok',
    scratchpad: 'ok',
    recording: ffmpegOk ? 'ok' : 'missing_dependency',
    notebook: 'ok',
  };
}

function addLog(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  agentLogs.push(`[${ts}] ${msg}`);
  if (agentLogs.length > 500) agentLogs.shift();

  // Parse public URL if present in logs
  const urlMatch = msg.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i) ||
                   msg.match(/https:\/\/[a-zA-Z0-9-]+\.loca\.lt/i) ||
                   msg.match(/Public URL:\s*(https?:\/\/[^\s]+)/i);
  if (urlMatch) {
    const matchedUrl = (urlMatch[1] || urlMatch[0]).trim();
    if (matchedUrl && matchedUrl !== agentConfig.public_url) {
      agentConfig.public_url = matchedUrl;
    }
  }
}

async function checkAgentHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function fetchLiveCapabilities(port: number): Promise<any> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/capabilities`, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function ensureAgentRunning() {
  if (process.env.NEXT_PHASE?.includes('build') || process.env.NEXT_PHASE?.includes('export')) {
    return;
  }
  const currentProc = getAgentProcess();
  console.log('[RVM Debug] ensureAgentRunning called. currentProc:', currentProc ? `pid ${currentProc.pid}, exitCode ${currentProc.exitCode}` : 'null');
  if (currentProc && currentProc.exitCode === null) {
    return;
  }
  const isHealthy = await checkAgentHealth(agentConfig.port);
  console.log('[RVM Debug] isHealthy:', isHealthy);
  if (isHealthy) return;

  const agentScriptPath = path.join(process.cwd(), 'rvm', 'agent', 'agent.js');
  console.log('[RVM Debug] Spawning agent at', agentScriptPath);
  addLog(`[auto-start] Auto-starting RVM Agent process on port ${agentConfig.port}...`);

  try {
    const proc = spawn('node', [agentScriptPath], {
      env: {
        ...process.env,
        PORT: String(agentConfig.port),
        TOKEN: agentConfig.token,
        ROOT: agentConfig.workspace || process.cwd(),
        VNC_PASSWORD: agentConfig.vnc_password,
        BIND: agentConfig.bind_address,
      },
      stdio: 'pipe',
    });
    setAgentProcess(proc);

    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) addLog(`[STDOUT] ${text}`);
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) addLog(`[STDERR] ${text}`);
    });

    proc.on('exit', (code) => {
      addLog(`RVM Agent process exited with code ${code}`);
      setAgentProcess(null);
    });

    // Wait for server startup and verify health
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const healthy = await checkAgentHealth(agentConfig.port);
      if (healthy) break;
    }
  } catch (err: any) {
    addLog(`[auto-start] Error spawning agent: ${err.message || err}`);
  }
}

export async function GET() {
  await ensureAgentRunning();
  const activeProc = getAgentProcess();
  const isHealthy = await checkAgentHealth(agentConfig.port);
  const isProcessRunning = activeProc !== null && activeProc.exitCode === null;
  const isRunning = isHealthy || isProcessRunning;
  const liveCaps = isHealthy ? await fetchLiveCapabilities(agentConfig.port) : null;

  // Try reading persisted connection snapshot for public URL
  let connPublicUrl = '';
  try {
    const connPath = path.join(process.cwd(), 'rvm', 'agent', 'conn.json');
    if (fs.existsSync(connPath)) {
      const connData = JSON.parse(fs.readFileSync(connPath, 'utf8'));
      if (connData.publicUrl) connPublicUrl = connData.publicUrl.trim();
    }
  } catch {}

  if (connPublicUrl) {
    agentConfig.public_url = connPublicUrl;
  }

  const effectivePublicUrl = agentConfig.public_url || `http://localhost:${agentConfig.port}`;

  const serverServicesStatus = getServerServicesStatus();

  const computedCapStatus = computeRealCapabilities(isHealthy, serverServicesStatus);

  return NextResponse.json({
    status: isHealthy ? 'running' : isProcessRunning ? 'starting' : 'stopped',
    pid: activeProc?.pid || 0,
    port: agentConfig.port,
    token: agentConfig.token,
    host: 'localhost',
    platform: process.platform,
    direct_url: `http://localhost:${agentConfig.port}`,
    public_url: effectivePublicUrl,
    vnc_port: 5900,
    cdp_port: 9222,
    workspace: agentConfig.workspace,
    logs: agentLogs.slice(-100),
    config: agentConfig,
    services: serverServicesStatus,
    live_capabilities: liveCaps,
    capability_status: computedCapStatus,
  });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { action, config: newConfig } = body;

    if (action === 'save_config' && newConfig) {
      agentConfig = { ...agentConfig, ...newConfig };
      addLog('Configuration updated.');
      return NextResponse.json({ success: true, config: agentConfig });
    }

    if (action === 'start') {
      let proc = getAgentProcess();
      if (proc && proc.exitCode === null) {
        return NextResponse.json({ success: true, message: 'Agent is already running' });
      }

      if (newConfig) {
        agentConfig = { ...agentConfig, ...newConfig };
      }

      const agentScriptPath = path.join(process.cwd(), 'rvm', 'agent', 'agent.js');
      addLog(`Launching RVM Agent on port ${agentConfig.port}...`);

      proc = spawn('node', [agentScriptPath], {
        env: {
          ...process.env,
          PORT: String(agentConfig.port),
          TOKEN: agentConfig.token,
          ROOT: agentConfig.workspace || process.cwd(),
          VNC_PASSWORD: agentConfig.vnc_password,
          BIND: agentConfig.bind_address,
        },
        stdio: 'pipe',
      });
      setAgentProcess(proc);

      proc.stdout?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) addLog(`[STDOUT] ${text}`);
      });

      proc.stderr?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) addLog(`[STDERR] ${text}`);
      });

      proc.on('exit', (code) => {
        addLog(`RVM Agent process exited with code ${code}`);
        setAgentProcess(null);
      });

      // Wait briefly for server startup
      await new Promise((r) => setTimeout(r, 800));

      return NextResponse.json({
        success: true,
        status: 'running',
        pid: proc.pid,
        port: agentConfig.port,
        token: agentConfig.token,
      });
    }

    if (action === 'stop') {
      const proc = getAgentProcess();
      if (proc) {
        addLog('Stopping RVM Agent...');
        proc.kill('SIGTERM');
        setAgentProcess(null);
      }
      return NextResponse.json({ success: true, status: 'stopped' });
    }

    if (action === 'install_service') {
      const { service } = body;
      if (!service) {
        return NextResponse.json({ error: 'Missing service name' }, { status: 400 });
      }
      const ok = await installService(service);
      return NextResponse.json({
        success: ok,
        service,
        installed: checkBinaryInstalled(service),
        message: ok ? `Successfully installed ${service}` : `Failed to install ${service}`
      });
    }

    if (action === 'install_all_services') {
      const allServices = ['cloudflared', 'novnc', 'web_ide', 'vnc_server', 'ffmpeg', 'git', 'browser'];
      const missing = allServices.filter(s => !checkBinaryInstalled(s));
      addLog(`[install] Found ${missing.length} missing services: ${missing.join(', ')}`);

      const results: Record<string, boolean> = {};
      for (const s of missing) {
        results[s] = await installService(s);
      }

      return NextResponse.json({
        success: true,
        installed_services: results,
        message: missing.length === 0 ? 'All services are already installed!' : `Completed installation for ${missing.length} services.`
      });
    }

    if (action === 'mcp_call') {
      const { method, params, port, token } = body;
      const targetPort = port || agentConfig.port;
      const targetToken = token || agentConfig.token;

      const mcpRes = await new Promise<{ statusCode: number; body: any }>((resolve) => {
        const postData = JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: method || 'initialize',
          params: params || {},
        });

        const request = http.request(
          {
            hostname: '127.0.0.1',
            port: targetPort,
            path: '/mcp',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
              Authorization: `Bearer ${targetToken}`,
            },
            timeout: 5000,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              let parsed = data;
              try {
                parsed = JSON.parse(data);
              } catch {}
              resolve({ statusCode: res.statusCode || 500, body: parsed });
            });
          }
        );

        request.on('error', (err) => {
          resolve({ statusCode: 500, body: { error: err.message } });
        });

        request.write(postData);
        request.end();
      });

      return NextResponse.json(mcpRes);
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

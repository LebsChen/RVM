use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, State};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub port: u16,
    pub token: String,
    pub workspace: String,
    pub vnc_password: String,
    pub tunnel_mode: String,
    pub tunnel_protocol: String,
    pub cf_tunnel_token: String,
    #[serde(default)]
    pub public_url: String,
    pub bind_address: String,
    // Service ids allowed to auto-install when missing (Server tab selection).
    // Missing/empty defaults to all downloadable services.
    #[serde(default = "default_auto_install")]
    pub auto_install: Vec<String>,
    // Optional GitHub download accelerator (prefix proxy or {url} template).
    // Passed to the agent as GITHUB_MIRROR to speed up GitHub downloads.
    #[serde(default)]
    pub github_mirror: String,
}

fn default_auto_install() -> Vec<String> {
    ALL_SERVICES.iter().map(|s| s.to_string()).collect()
}

const ALL_SERVICES: [&str; 7] = [
    "cloudflared",
    "novnc",
    "web_ide",
    "vnc_server",
    "ffmpeg",
    "git",
    "browser",
];

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            port: 9876,
            token: String::new(),
            workspace: String::new(),
            vnc_password: "devin".into(),
            tunnel_mode: "auto".into(),
            tunnel_protocol: "http2".into(),
            cf_tunnel_token: String::new(),
            public_url: String::new(),
            bind_address: "0.0.0.0".into(),
            auto_install: default_auto_install(),
            github_mirror: "https://gh-proxy.com/".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    pub status: String,
    pub port: u16,
    pub token: String,
    pub host: String,
    pub platform: String,
    pub direct_url: String,
    pub public_url: String,
    pub vnc_port: u16,
    pub cdp_port: u16,
    pub pid: u32,
    pub error: String,
    pub workspace: String,
    pub capability_status: HashMap<String, String>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            status: "stopped".into(),
            port: 0,
            token: String::new(),
            host: String::new(),
            platform: String::new(),
            direct_url: String::new(),
            public_url: String::new(),
            vnc_port: 0,
            cdp_port: 0,
            pid: 0,
            error: String::new(),
            workspace: String::new(),
            capability_status: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutpostConfig {
    #[serde(default)]
    pub outpost_id: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub auto_start: bool,
}

impl Default for OutpostConfig {
    fn default() -> Self {
        Self {
            outpost_id: String::new(),
            token: String::new(),
            working_directory: String::new(),
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutpostState {
    pub status: String,
    pub pid: u32,
    pub outpost_id: String,
    pub auto_start: bool,
    pub cli_available: bool,
    pub error: String,
}

impl Default for OutpostState {
    fn default() -> Self {
        Self {
            status: "stopped".into(),
            pid: 0,
            outpost_id: String::new(),
            auto_start: false,
            cli_available: false,
            error: String::new(),
        }
    }
}

struct AppState {
    agent_process: Mutex<Option<Child>>,
    agent_state: Mutex<AgentState>,
    config: Mutex<AgentConfig>,
    agent_logs: Arc<Mutex<Vec<String>>>,
    outpost_process: Mutex<Option<Child>>,
    outpost_state: Mutex<OutpostState>,
    outpost_logs: Arc<Mutex<Vec<String>>>,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".rvm")
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

fn outpost_config_path() -> PathBuf {
    config_dir().join("outpost.json")
}

fn conn_json_path() -> PathBuf {
    config_dir().join("conn.json")
}

fn new_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[cfg(target_os = "windows")]
    let mut command = Command::new(program);
    #[cfg(not(target_os = "windows"))]
    let command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

/// Ask the worker to exit gracefully (so it can release its queue claims)
/// before force-killing the process tree. Closing the worker's piped stdin
/// signals shutdown on every platform (Windows has no SIGTERM); Unix also
/// gets a SIGTERM so a wedged stdin reader still hears it.
#[cfg(desktop)]
fn terminate_child_gracefully(child: &mut Child) {
    drop(child.stdin.take());
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
    }
    for _ in 0..30 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    kill_process_tree_best_effort(child);
}

#[cfg(desktop)]
fn kill_process_tree_best_effort(child: &mut Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let _ = new_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = kill_process_tree_unix(pid);
        let _ = child.kill();
    }
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn kill_process_tree_unix(root_pid: u32) -> std::io::Result<()> {
    use std::collections::{HashMap, HashSet};
    let out = Command::new("ps")
        .args(["-eo", "pid=,ppid="])
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let pid = parts.next().and_then(|s| s.parse::<u32>().ok());
        let ppid = parts.next().and_then(|s| s.parse::<u32>().ok());
        if let (Some(pid), Some(ppid)) = (pid, ppid) {
            children.entry(ppid).or_default().push(pid);
        }
    }

    fn collect(pid: u32, children: &HashMap<u32, Vec<u32>>, seen: &mut HashSet<u32>, out: &mut Vec<u32>) {
        if !seen.insert(pid) {
            return;
        }
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                collect(kid, children, seen, out);
            }
        }
        out.push(pid);
    }

    let mut order = Vec::new();
    let mut seen = HashSet::new();
    collect(root_pid, &children, &mut seen, &mut order);
    for pid in order {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
    Ok(())
}

fn agent_dir() -> PathBuf {
    // Tauri bundles "../agent/**/*" resources into a "_up_/agent/" directory
    // relative to the resources root. The resources root varies by platform:
    //   Windows NSIS: <install_dir>/_up_/agent/
    //   Linux .deb:   /usr/lib/RVM/_up_/agent/
    //   Linux AppImage: <mount>/usr/lib/RVM/_up_/agent/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Direct: exe_dir/agent/ or exe_dir/_up_/agent/
            for sub in &["agent", "_up_/agent"] {
                let p = exe_dir.join(sub);
                if p.exists() {
                    return p;
                }
            }
            // Linux .deb / AppImage: exe is in /usr/bin/, resources in
            // /usr/lib/<productName>/_up_/agent/
            if let Some(usr) = exe_dir.parent() {
                for name in &["RVM", "rvm"] {
                    for sub in &["_up_/agent", "agent"] {
                        let p = usr.join("lib").join(name).join(sub);
                        if p.exists() {
                            return p;
                        }
                    }
                }
            }
        }
    }
    // Development: relative to the Cargo manifest directory (src-tauri/../agent)
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|d| d.join("agent"))
        .unwrap_or_else(|| PathBuf::from("agent"));
    if dev_path.exists() {
        return dev_path;
    }
    PathBuf::from("agent")
}

fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..24).map(|_| rng.gen()).collect();
    hex::encode(bytes)
}

fn get_hostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

// Pinned Node.js LTS used by the "install Node.js" helper.
const MANAGED_NODE_VERSION: &str = "v20.18.1";

// Directory that holds an RVM-managed Node.js runtime (~/.rvm/node).
fn managed_node_dir() -> PathBuf {
    config_dir().join("node")
}

// Path to the node binary inside the managed runtime, if present.
fn managed_node_bin() -> Option<String> {
    let bin = if cfg!(target_os = "windows") {
        managed_node_dir().join("node.exe")
    } else {
        managed_node_dir().join("bin").join("node")
    };
    if bin.exists() {
        Some(bin.to_string_lossy().to_string())
    } else {
        None
    }
}

fn find_node() -> Option<String> {
    // Prefer an RVM-managed runtime so a system install is not required.
    if let Some(bin) = managed_node_bin() {
        return Some(bin);
    }
    let names = if cfg!(target_os = "windows") {
        vec!["node.exe"]
    } else {
        vec!["node"]
    };
    for name in names {
        let check = if cfg!(target_os = "windows") {
            new_command("where").arg(name).output()
        } else {
            Command::new("which").arg(name).output()
        };
        if let Ok(o) = check {
            if o.status.success() {
                let path = String::from_utf8_lossy(&o.stdout).trim().lines().next().unwrap_or("").to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }
    None
}

// Directory containing the resolved node binary, for PATH augmentation so that
// npm/npx child processes spawned by the agent can be found.
fn node_bin_dir() -> Option<String> {
    find_node()
        .map(PathBuf::from)
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
}

fn node_version(node: &str) -> String {
    new_command(node)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

// Download and extract the official Node.js LTS build into ~/.rvm/node using
// system tools (curl/tar on unix, PowerShell on Windows). No sudo required.
fn install_managed_node() -> Result<String, String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("不支持的 CPU 架构: {}", other)),
    };
    let dir = managed_node_dir();
    let parent = config_dir();
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    let ver = MANAGED_NODE_VERSION;

    #[cfg(target_os = "windows")]
    {
        let name = format!("node-{}-win-{}", ver, arch);
        let url = format!("https://nodejs.org/dist/{}/{}.zip", ver, name);
        let zip = parent.join("node-download.zip");
        let script = format!(
            "$ErrorActionPreference='Stop'; \
             Invoke-WebRequest -Uri '{url}' -OutFile '{zip}'; \
             Expand-Archive -Path '{zip}' -DestinationPath '{parent}' -Force; \
             Rename-Item -Path '{extracted}' -NewName 'node'; \
             Remove-Item '{zip}' -Force",
            url = url,
            zip = zip.display(),
            parent = parent.display(),
            extracted = parent.join(&name).display(),
        );
        let output = new_command("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| format!("启动 PowerShell 失败: {}", e))?;
        if !output.status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "Node.js 安装失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let os = if cfg!(target_os = "macos") { "darwin" } else { "linux" };
        let name = format!("node-{}-{}-{}", ver, os, arch);
        let url = format!("https://nodejs.org/dist/{}/{}.tar.gz", ver, name);
        let tarball = parent.join("node-download.tar.gz");
        let script = format!(
            "set -e; \
             curl -fsSL '{url}' -o '{tar}'; \
             tar -xzf '{tar}' -C '{parent}'; \
             rm -rf '{dir}'; \
             mv '{extracted}' '{dir}'; \
             rm -f '{tar}'",
            url = url,
            tar = tarball.display(),
            parent = parent.display(),
            dir = dir.display(),
            extracted = parent.join(&name).display(),
        );
        let output = Command::new("bash")
            .args(["-lc", &script])
            .output()
            .map_err(|e| format!("启动安装脚本失败: {}", e))?;
        if !output.status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "Node.js 安装失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    match managed_node_bin() {
        Some(bin) => {
            let version = node_version(&bin);
            Ok(format!("已安装 Node.js {}", if version.is_empty() { ver.to_string() } else { version }))
        }
        None => Err("Node.js 安装后未找到可执行文件".into()),
    }
}

fn find_devin_cli() -> Option<String> {
    let command = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let name = if cfg!(target_os = "windows") {
        "devin.exe"
    } else {
        "devin"
    };
    if let Ok(output) = new_command(command).arg(name).output() {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
            {
                let path = PathBuf::from(path);
                if let Ok(absolute) = std::fs::canonicalize(&path) {
                    return Some(absolute.to_string_lossy().to_string());
                }
                if path.is_absolute() {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let fallback = PathBuf::from(local_app_data)
            .join("devin")
            .join("cli")
            .join("bin")
            .join(name);
        if fallback.exists() {
            return std::fs::canonicalize(&fallback)
                .ok()
                .or(Some(fallback))
                .map(|path| path.to_string_lossy().to_string());
        }
    }

    let fallback = dirs::home_dir()?.join(".local").join("bin").join(name);
    fallback.exists().then(|| {
        std::fs::canonicalize(&fallback)
            .ok()
            .or(Some(fallback))
            .map(|path| path.to_string_lossy().to_string())
    })?
}

fn augmented_path() -> String {
    let mut local_bins = Vec::new();
    if let Some(local_bin) = dirs::home_dir().map(|home| {
        home.join(".local")
            .join("bin")
            .to_string_lossy()
            .to_string()
    }) {
        local_bins.push(local_bin);
    }
    #[cfg(target_os = "windows")]
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let local_bin = PathBuf::from(local_app_data)
            .join("devin")
            .join("cli")
            .join("bin");
        if local_bin.is_dir() {
            local_bins.push(local_bin.to_string_lossy().to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let git_dir = config_dir().join("git");
        for git_bin in [
            git_dir.join("usr").join("bin"),
            git_dir.join("mingw64").join("bin"),
            git_dir.join("cmd"),
        ] {
            if git_bin.is_dir() {
                local_bins.push(git_bin.to_string_lossy().to_string());
            }
        }
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let separator = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };
    let mut prefixes = Vec::new();
    for path in local_bins {
        let already_present = current.split(separator).any(|part| {
            if cfg!(target_os = "windows") {
                part.eq_ignore_ascii_case(&path)
            } else {
                part == path
            }
        }) || prefixes.iter().any(|part: &String| {
            if cfg!(target_os = "windows") {
                part.eq_ignore_ascii_case(&path)
            } else {
                part == &path
            }
        });
        if !already_present {
            prefixes.push(path);
        }
    }
    if prefixes.is_empty() {
        current
    } else if current.is_empty() {
        prefixes.join(&separator.to_string())
    } else {
        format!("{}{}{}", prefixes.join(&separator.to_string()), separator, current)
    }
}

// ── Read conn.json written by agent.js ─────────────────────────────────────

fn read_conn_json() -> Option<serde_json::Value> {
    let path = conn_json_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn read_outpost_config() -> OutpostConfig {
    std::fs::read_to_string(outpost_config_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn spawn_outpost(cfg: &OutpostConfig, state: &AppState) -> Result<OutpostState, String> {
    let outpost_id = cfg.outpost_id.trim();
    let token = cfg.token.trim();
    if outpost_id.is_empty() || token.is_empty() {
        return Err("Outpost ID and worker token are required".into());
    }

    let node = find_node().ok_or("未找到 Node.js，请先安装 Node.js")?;

    {
        let mut process = state.outpost_process.lock().unwrap();
        if let Some(child) = process.as_mut() {
            match child.try_wait() {
                Ok(None) => return Err("Worker already running".into()),
                Ok(Some(_)) | Err(_) => *process = None,
            }
        }
    }

    let script = agent_dir().join("outpost.js");
    if !script.exists() {
        return Err(format!(
            "outpost.js not found at {}. Please ensure the agent files are bundled.",
            script.display()
        ));
    }

    let working_directory = cfg.working_directory.trim();
    let mut cmd = new_command(&node);
    cmd.arg(script.to_string_lossy().as_ref())
        .env("DEVIN_OUTPOSTS_TOKEN", token)
        .env("OUTPOST_ID", outpost_id)
        .env("RVM_OUTPOST_WORKDIR", working_directory)
        .env("PATH", augmented_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Ok(api_url) = std::env::var("DEVIN_API_URL") {
        cmd.env("DEVIN_API_URL", api_url);
    }
    if !working_directory.is_empty() {
        let dir = Path::new(working_directory);
        if !dir.is_dir() {
            return Err(format!(
                "工作目录无效: {}（请填写存在的目录路径，或留空使用默认）",
                working_directory
            ));
        }
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Outpost worker: {}", e))?;

    state.outpost_logs.lock().unwrap().clear();
    {
        let logs = Arc::clone(&state.outpost_logs);
        let token = token.to_string();
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        let redacted = line.replace(&token, "***");
                        let mut logs = logs.lock().unwrap();
                        logs.push(redacted);
                        let len = logs.len();
                        if len > 1000 {
                            logs.drain(0..len - 1000);
                        }
                    }
                }
            });
        }
    }
    {
        let logs = Arc::clone(&state.outpost_logs);
        let token = token.to_string();
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        let redacted = line.replace(&token, "***");
                        let mut logs = logs.lock().unwrap();
                        logs.push(format!("[stderr] {}", redacted));
                        let len = logs.len();
                        if len > 1000 {
                            logs.drain(0..len - 1000);
                        }
                    }
                }
            });
        }
    }

    let result = OutpostState {
        status: "running".into(),
        pid: child.id(),
        outpost_id: outpost_id.to_string(),
        auto_start: cfg.auto_start,
        cli_available: true,
        error: String::new(),
    };
    *state.outpost_process.lock().unwrap() = Some(child);
    *state.outpost_state.lock().unwrap() = result.clone();
    Ok(result)
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
fn load_config(state: State<AppState>) -> AgentConfig {
    // Try loading from disk
    if let Ok(data) = std::fs::read_to_string(config_path()) {
        if let Ok(c) = serde_json::from_str::<AgentConfig>(&data) {
            let mut cfg = state.config.lock().unwrap();
            *cfg = c.clone();
            return c;
        }
    }
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn get_agent_state(state: State<AppState>) -> AgentState {
    let mut s = state.agent_state.lock().unwrap().clone();

    // Check if process is still alive
    if s.status == "running" {
        let mut proc = state.agent_process.lock().unwrap();
        if let Some(ref mut child) = *proc {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    let code = exit.code().unwrap_or(-1);
                    s.status = "error".into();
                    // Include recent logs in the error message for visibility
                    let logs = state.agent_logs.lock().unwrap();
                    let recent: Vec<&String> = logs.iter().rev().take(20).collect();
                    if recent.is_empty() {
                        s.error = format!("Agent exited with code {}", code);
                    } else {
                        let log_tail: Vec<&str> = recent.iter().rev().map(|s| s.as_str()).collect();
                        s.error = format!("Agent exited with code {}.\nLast output:\n{}", code, log_tail.join("\n"));
                    }
                    *proc = None;
                    let mut st = state.agent_state.lock().unwrap();
                    st.status = s.status.clone();
                    st.error = s.error.clone();
                    return st.clone();
                }
                Ok(None) => {} // still running
                Err(_) => {}
            }
        }
    }

    // Update from conn.json (tunnel URL, vnc_port, etc.)
    if s.status == "running" {
        if let Some(conn) = read_conn_json() {
            let mut changed = false;
            if let Some(url) = conn.get("publicUrl").and_then(|v| v.as_str()) {
                if s.public_url != url {
                    s.public_url = url.to_string();
                    changed = true;
                }
            }
            if let Some(vp) = conn.get("vncPort").and_then(|v| v.as_u64()) {
                if vp > 0 {
                    s.vnc_port = vp as u16;
                    changed = true;
                }
            }
            if let Some(du) = conn.get("directUrl").and_then(|v| v.as_str()) {
                if s.direct_url != du {
                    s.direct_url = du.to_string();
                    changed = true;
                }
            }
            if let Some(status) = conn.get("capabilityStatus").and_then(|v| v.as_object()) {
                let next: HashMap<String, String> = status
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect();
                if s.capability_status != next {
                    s.capability_status = next;
                    changed = true;
                }
            }
            if changed {
                let mut st = state.agent_state.lock().unwrap();
                st.public_url = s.public_url.clone();
                st.vnc_port = s.vnc_port;
                st.direct_url = s.direct_url.clone();
                st.capability_status = s.capability_status.clone();
            }
        }
    }

    s
}

#[tauri::command]
fn start_agent(config: AgentConfig, state: State<AppState>) -> Result<AgentState, String> {
    // Check if already running
    {
        let proc = state.agent_process.lock().unwrap();
        if proc.is_some() {
            return Err("Agent is already running".into());
        }
    }

    // Find Node.js
    let node = find_node().ok_or("Node.js not found. Please install Node.js first.")?;

    // Resolve token
    let token = if config.token.is_empty() {
        generate_token()
    } else {
        config.token.clone()
    };

    // Resolve workspace
    let workspace = if config.workspace.is_empty() {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".into())
    } else {
        config.workspace.clone()
    };

    // Ensure config dir exists
    let _ = std::fs::create_dir_all(config_dir());

    // Save config
    let mut saved_config = config.clone();
    saved_config.token = token.clone();
    saved_config.workspace = workspace.clone();
    if let Ok(json) = serde_json::to_string_pretty(&saved_config) {
        let _ = std::fs::write(config_path(), json);
    }

    // Find agent.js
    let agent_js = agent_dir().join("agent.js");
    if !agent_js.exists() {
        return Err(format!(
            "agent.js not found at {}. Please ensure the agent files are bundled.",
            agent_js.display()
        ));
    }

    // Build environment
    let mut cmd = new_command(&node);
    cmd.arg(agent_js.to_string_lossy().as_ref());
    // Ensure the resolved node's directory is on PATH so npm/npx child
    // processes (e.g. managed Node.js under ~/.rvm/node) are found.
    if let Some(bin_dir) = node_bin_dir() {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        let current = std::env::var("PATH").unwrap_or_default();
        if !current.split(sep).any(|p| p == bin_dir) {
            let combined = if current.is_empty() {
                bin_dir
            } else {
                format!("{}{}{}", bin_dir, sep, current)
            };
            cmd.env("PATH", combined);
        }
    }
    cmd.env("TOKEN", &token);
    cmd.env("PORT", config.port.to_string());
    cmd.env("ROOT", &workspace);
    cmd.env("BIND", &config.bind_address);
    cmd.env("VNC_PASSWORD", &config.vnc_password);
    cmd.env("CONN_DIR", config_dir().to_string_lossy().as_ref());
    // Services allowed to auto-install when missing (Server tab selection).
    cmd.env("AUTO_INSTALL", config.auto_install.join(","));
    if !config.github_mirror.trim().is_empty() {
        cmd.env("GITHUB_MIRROR", config.github_mirror.trim());
    }

    // Tunnel protocol
    if !config.tunnel_protocol.is_empty() {
        cmd.env("TUNNEL_PROTOCOL", &config.tunnel_protocol);
    }

    match config.tunnel_mode.as_str() {
        "off" => {
            cmd.env("TUNNEL", "off");
        }
        "named" => {
            cmd.env("TUNNEL", "on");
            if !config.cf_tunnel_token.is_empty() {
                cmd.env("CF_TUNNEL_TOKEN", &config.cf_tunnel_token);
            }
            let public_url = config.public_url.trim();
            if !public_url.is_empty() {
                cmd.env("TUNNEL_PUBLIC_URL", public_url);
            }
        }
        _ => {
            cmd.env("TUNNEL", "auto");
        }
    }

    // Spawn
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn agent: {}", e))?;

    // Clear previous logs
    state.agent_logs.lock().unwrap().clear();

    // Spawn background threads to read stdout/stderr and populate logs
    {
        let logs = Arc::clone(&state.agent_logs);
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let mut logs = logs.lock().unwrap();
                        logs.push(l);
                        // Keep only last 1000 lines
                        let len = logs.len();
                        if len > 1000 {
                            logs.drain(0..len - 1000);
                        }
                    }
                }
            });
        }
    }
    {
        let logs = Arc::clone(&state.agent_logs);
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let mut logs = logs.lock().unwrap();
                        logs.push(format!("[stderr] {}", l));
                        let len = logs.len();
                        if len > 1000 {
                            logs.drain(0..len - 1000);
                        }
                    }
                }
            });
        }
    }

    let pid = child.id();
    let host = get_hostname();
    let platform = std::env::consts::OS.to_string();

    let agent_state = AgentState {
        status: "running".into(),
        port: config.port,
        token: token.clone(),
        host: host.clone(),
        platform,
        direct_url: String::new(),
        public_url: String::new(),
        vnc_port: 0,
        cdp_port: 0,
        pid,
        error: String::new(),
        workspace,
        capability_status: HashMap::new(),
    };

    // Store state
    {
        let mut proc = state.agent_process.lock().unwrap();
        *proc = Some(child);
    }
    {
        let mut st = state.agent_state.lock().unwrap();
        *st = agent_state.clone();
    }
    {
        let mut cfg = state.config.lock().unwrap();
        *cfg = saved_config;
    }

    Ok(agent_state)
}

#[tauri::command]
fn get_agent_logs(state: State<'_, AppState>) -> Vec<String> {
    state.agent_logs.lock().unwrap().clone()
}

#[tauri::command]
fn stop_agent(state: State<AppState>) -> Result<(), String> {
    let mut proc = state.agent_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        kill_process_tree_best_effort(child);
        let _ = child.wait();
    }
    *proc = None;

    let mut st = state.agent_state.lock().unwrap();
    *st = AgentState::default();

    // Clear logs
    state.agent_logs.lock().unwrap().clear();

    // Clean up conn.json
    let _ = std::fs::remove_file(conn_json_path());

    Ok(())
}

#[tauri::command]
fn save_config(config: AgentConfig, state: State<AppState>) -> Result<(), String> {
    let _ = std::fs::create_dir_all(config_dir());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), json).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

#[tauri::command]
fn load_outpost_config() -> OutpostConfig {
    read_outpost_config()
}

#[tauri::command]
fn save_outpost_config(config: OutpostConfig) -> Result<(), String> {
    std::fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(outpost_config_path(), json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            outpost_config_path(),
            std::fs::Permissions::from_mode(0o600),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn start_outpost_worker(state: State<AppState>) -> Result<OutpostState, String> {
    let config = read_outpost_config();
    spawn_outpost(&config, &state)
}

#[tauri::command]
fn stop_outpost_worker(state: State<AppState>) -> Result<(), String> {
    let mut process = state.outpost_process.lock().unwrap();
    if let Some(child) = process.as_mut() {
        terminate_child_gracefully(child);
        let _ = child.wait();
    }
    *process = None;
    *state.outpost_state.lock().unwrap() = OutpostState::default();
    state.outpost_logs.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
fn get_outpost_state(state: State<AppState>) -> OutpostState {
    let mut current = state.outpost_state.lock().unwrap().clone();
    if current.status == "running" {
        let mut process = state.outpost_process.lock().unwrap();
        if let Some(child) = process.as_mut() {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    let code = exit.code().unwrap_or(-1);
                    current.status = "error".into();
                    let logs = state.outpost_logs.lock().unwrap();
                    let recent: Vec<&str> =
                        logs.iter().rev().take(20).map(String::as_str).collect();
                    current.error = if recent.is_empty() {
                        format!("Worker exited code {}", code)
                    } else {
                        let tail: Vec<&str> = recent.into_iter().rev().collect();
                        format!(
                            "Worker exited code {}.\nLast output:\n{}",
                            code,
                            tail.join("\n")
                        )
                    };
                    *process = None;
                    *state.outpost_state.lock().unwrap() = current.clone();
                }
                Ok(None) | Err(_) => {}
            }
        }
    }
    current.cli_available = find_node().is_some();
    if let Ok(mut state_value) = state.outpost_state.lock() {
        state_value.cli_available = current.cli_available;
    }
    current
}

#[tauri::command]
fn get_outpost_logs(state: State<AppState>) -> Vec<String> {
    state.outpost_logs.lock().unwrap().clone()
}

#[tauri::command]
fn install_outpost_cli() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let mut installer = new_command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm https://cli.devin.ai/install.ps1 | iex",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to run CLI installer: {}", e))?;
        return poll_for_devin_cli(&mut installer);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut installer = Command::new("setsid")
            .args(["bash", "-lc", "curl -fsSL https://cli.devin.ai/install.sh | bash"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to run CLI installer: {}", e))?;
        poll_for_devin_cli(&mut installer)
    }
}

fn poll_for_devin_cli(installer: &mut Child) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if let Some(path) = find_devin_cli() {
            terminate_installer_best_effort(installer);
            return Ok(format!("Devin CLI installed: {}", path));
        }

        match installer.try_wait() {
            Ok(Some(status)) => {
                terminate_installer_best_effort(installer);
                return Err(format!(
                    "Devin CLI installer exited before the CLI became available ({})",
                    status
                ));
            }
            Ok(None) => {}
            Err(error) => {
                terminate_installer_best_effort(installer);
                return Err(format!("Failed to monitor Devin CLI installer: {}", error));
            }
        }

        if Instant::now() >= deadline {
            terminate_installer_best_effort(installer);
            return Err(
                "Timed out waiting for the Devin CLI to become available after 300 seconds".into(),
            );
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn terminate_installer_best_effort(child: &mut Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let _ = new_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", pid)])
            .status();
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeStatus {
    pub available: bool,
    pub version: String,
    pub path: String,
    pub managed: bool,
}

#[tauri::command]
fn get_node_status() -> NodeStatus {
    match find_node() {
        Some(path) => {
            let managed = managed_node_bin().as_deref() == Some(path.as_str());
            NodeStatus {
                available: true,
                version: node_version(&path),
                path,
                managed,
            }
        }
        None => NodeStatus {
            available: false,
            version: String::new(),
            path: String::new(),
            managed: false,
        },
    }
}

#[tauri::command]
fn install_node() -> Result<String, String> {
    install_managed_node()
}

// Run agent/installer.js with the given args and return its stdout (JSON).
fn run_installer(args: &[&str]) -> Result<String, String> {
    let node = find_node().ok_or("Node.js not found. Please install Node.js first.")?;
    let script = agent_dir().join("installer.js");
    if !script.exists() {
        return Err(format!("installer.js not found at {}", script.display()));
    }
    let mut cmd = new_command(&node);
    cmd.arg(script.to_string_lossy().as_ref());
    for a in args {
        cmd.arg(a);
    }
    let out = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run installer: {}", e))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
fn get_server_status() -> Result<serde_json::Value, String> {
    let stdout = run_installer(&["status"])?;
    serde_json::from_str(&stdout).map_err(|e| format!("parse status failed: {} ({})", e, stdout))
}

#[tauri::command]
fn install_service(id: String) -> Result<serde_json::Value, String> {
    let stdout = run_installer(&["install", &id])?;
    serde_json::from_str(&stdout).map_err(|e| format!("parse install result failed: {} ({})", e, stdout))
}

#[tauri::command]
fn uninstall_service(id: String) -> Result<serde_json::Value, String> {
    let stdout = run_installer(&["uninstall", &id])?;
    serde_json::from_str(&stdout).map_err(|e| format!("parse uninstall result failed: {} ({})", e, stdout))
}

#[tauri::command]
fn uninstall_all_services() -> Result<serde_json::Value, String> {
    let stdout = run_installer(&["uninstall-all"])?;
    serde_json::from_str(&stdout).map_err(|e| format!("parse uninstall-all result failed: {} ({})", e, stdout))
}

// ── App ────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            agent_process: Mutex::new(None),
            agent_state: Mutex::new(AgentState::default()),
            config: Mutex::new(AgentConfig::default()),
            agent_logs: Arc::new(Mutex::new(Vec::new())),
            outpost_process: Mutex::new(None),
            outpost_state: Mutex::new(OutpostState::default()),
            outpost_logs: Arc::new(Mutex::new(Vec::new())),
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            let config = read_outpost_config();
            if config.auto_start
                && !config.outpost_id.trim().is_empty()
                && !config.token.trim().is_empty()
            {
                let _ = spawn_outpost(&config, &state);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            get_agent_state,
            get_agent_logs,
            start_agent,
            stop_agent,
            load_outpost_config,
            save_outpost_config,
            start_outpost_worker,
            stop_outpost_worker,
            get_outpost_state,
            get_outpost_logs,
            install_outpost_cli,
            get_node_status,
            install_node,
            get_server_status,
            install_service,
            uninstall_service,
            uninstall_all_services,
        ])
        .run(tauri::generate_context!())
        .expect("error running RVM");
}

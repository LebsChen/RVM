"use strict";
// Port forwarding module — expose local ports via cloudflare tunnel
// Maps to official devin-remote expose_port.rs

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const exposedPorts = new Map(); // port -> { proc, url, started }

async function handleRoute(body) {
  const { action, port, protocol } = body;

  switch (action || "expose") {
    case "expose": return exposePort(port, protocol);
    case "unexpose": return unexposePort(port);
    case "list": return listPorts();
    default:
      return { status: 400, body: { error: `unknown action: ${action}` } };
  }
}

async function exposePort(port, protocol) {
  if (!port) return { status: 400, body: { error: "port required" } };
  if (exposedPorts.has(port)) {
    const entry = exposedPorts.get(port);
    return { status: 200, body: { port, url: entry.url, already: true } };
  }

  const cfPath = findCloudflared();
  if (!cfPath) {
    return { status: 500, body: { error: "cloudflared not found. Install cloudflared to expose ports." } };
  }

  const proto = protocol || "http";
  const args = ["tunnel", "--url", `${proto}://localhost:${port}`, "--no-autoupdate"];
  const proc = spawn(cfPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  let url = "";
  const entry = { proc, url: "", started: Date.now() };
  exposedPorts.set(port, entry);

  return new Promise((resolve) => {
    let resolved = false;
    const urlRegex = /https?:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        url = match[0];
        entry.url = url;
        resolve({ status: 200, body: { port, url, pid: proc.pid } });
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", () => {
      exposedPorts.delete(port);
      if (!resolved) {
        resolved = true;
        resolve({ status: 500, body: { error: "cloudflared exited before establishing tunnel" } });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ status: 200, body: { port, url: "(pending)", pid: proc.pid, message: "Tunnel starting, URL not yet available" } });
      }
    }, 15000);
  });
}

function unexposePort(port) {
  if (!port) return { status: 400, body: { error: "port required" } };
  const entry = exposedPorts.get(port);
  if (!entry) return { status: 404, body: { error: `port ${port} not exposed` } };
  try { entry.proc.kill(); } catch {}
  exposedPorts.delete(port);
  return { status: 200, body: { ok: true, port } };
}

function listPorts() {
  const ports = [];
  for (const [port, entry] of exposedPorts) {
    ports.push({ port, url: entry.url, started: entry.started, pid: entry.proc.pid });
  }
  return { status: 200, body: { ports } };
}

function findCloudflared() {
  const isWin = process.platform === "win32";
  const names = isWin ? ["cloudflared.exe"] : ["cloudflared"];

  // Check PATH
  const { execFileSync } = require("child_process");
  for (const name of names) {
    try {
      const cmd = isWin ? "where" : "which";
      const result = execFileSync(cmd, [name], { encoding: "utf8", timeout: 5000 });
      const p = result.trim().split("\n")[0];
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }

  // Check common locations
  const locations = isWin
    ? [
        path.join(process.env.PROGRAMFILES || "C:\\Program Files", "cloudflared", "cloudflared.exe"),
        path.join(os.homedir(), "cloudflared.exe"),
      ]
    : [
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
        path.join(os.homedir(), ".local/bin/cloudflared"),
        path.join(os.homedir(), "cloudflared"),
      ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }

  return null;
}

module.exports = { handleRoute };

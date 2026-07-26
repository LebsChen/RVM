"use strict";
// Deploy module — ZIP project upload, deployment support
// Maps to official devin-remote deploys.rs

const fs = require("fs");
const path = require("path");
const os = require("os");
const { runShell } = require("./core.js");

const DEPLOY_DIR = path.join(os.homedir(), ".rvm", "deploys");

async function handleRoute(route, method, body) {
  const sub = route.replace("/api/deploy/", "");

  switch (sub) {
    case "upload":
      return handleDeployUpload(body);
    case "list":
      return handleDeployList();
    case "extract":
      return handleDeployExtract(body);
    case "status":
      return handleDeployStatus(body);
    default:
      return { status: 404, body: { error: `unknown deploy route: ${sub}` } };
  }
}

function handleDeployUpload(body) {
  const { name, content, project_dir } = body;
  if (!content) return { status: 400, body: { error: "content (base64) required" } };
  try {
    if (!fs.existsSync(DEPLOY_DIR)) fs.mkdirSync(DEPLOY_DIR, { recursive: true });
    const id = `deploy-${Date.now()}`;
    const fileName = name || `${id}.zip`;
    const filePath = path.join(DEPLOY_DIR, fileName);
    const buf = Buffer.from(content, "base64");
    fs.writeFileSync(filePath, buf);
    return {
      status: 200,
      body: {
        ok: true,
        id,
        path: filePath,
        zip_bytes: buf.length,
        file_count: 0, // counted after extraction
        project_dir: project_dir || DEPLOY_DIR,
      },
    };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleDeployList() {
  try {
    if (!fs.existsSync(DEPLOY_DIR)) return { status: 200, body: { deploys: [] } };
    const files = fs.readdirSync(DEPLOY_DIR).map((f) => ({
      name: f,
      path: path.join(DEPLOY_DIR, f),
      size: fs.statSync(path.join(DEPLOY_DIR, f)).size,
    }));
    return { status: 200, body: { deploys: files } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

async function handleDeployExtract(body) {
  const { zip_path, dest } = body;
  if (!zip_path) return { status: 400, body: { error: "zip_path required" } };
  const target = dest || path.join(DEPLOY_DIR, `extracted-${Date.now()}`);
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? `Expand-Archive -Path '${zip_path}' -DestinationPath '${target}' -Force`
      : `unzip -o '${zip_path}' -d '${target}'`;
    const r = await runShell(cmd, undefined, 120000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { ...r, dest: target } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleDeployStatus(body) {
  const { id } = body;
  return { status: 200, body: { id, status: "completed" } };
}

module.exports = { handleRoute };

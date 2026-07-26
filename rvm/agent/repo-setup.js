"use strict";
// Repo setup module — clone, install deps, build
// Maps to official devin-remote repo_setup.rs

const { runShell } = require("./core.js");
const fs = require("fs");
const path = require("path");

async function handleRoute(route, method, body, root) {
  const sub = route.replace("/api/repo/", "");

  switch (sub) {
    case "clone": return repoClone(body, root);
    case "setup": return repoSetup(body, root);
    case "install": return repoInstall(body, root);
    case "build": return repoBuild(body, root);
    case "detect": return repoDetect(body, root);
    default:
      return { status: 404, body: { error: `unknown repo route: ${sub}` } };
  }
}

async function repoClone(body, root) {
  const { url, dest, branch, depth } = body;
  if (!url) return { status: 400, body: { error: "url required" } };
  const repoName = path.basename(url, ".git");
  const target = dest || path.join(root, repoName);
  let cmd = `git clone`;
  if (branch) cmd += ` -b '${branch}'`;
  if (depth) cmd += ` --depth ${depth}`;
  cmd += ` '${url}' '${target}'`;
  const r = await runShell(cmd, root, 600000);
  return { status: r.exit_code === 0 ? 200 : 500, body: { ...r, path: target, repo: repoName } };
}

async function repoSetup(body, root) {
  const { path: repoPath, url } = body;
  const cwd = repoPath || root;
  const steps = [];

  // Auto-detect and run full setup
  if (url && !fs.existsSync(cwd)) {
    const clone = await repoClone({ url, dest: cwd }, root);
    steps.push({ step: "clone", ...clone.body });
    if (clone.status !== 200) return { status: 500, body: { steps, error: "clone failed" } };
  }

  const detect = await repoDetect({ path: cwd }, root);
  steps.push({ step: "detect", ...detect.body });

  const install = await repoInstall({ path: cwd }, root);
  steps.push({ step: "install", ...install.body });

  const build = await repoBuild({ path: cwd }, root);
  steps.push({ step: "build", ...build.body });

  return { status: 200, body: { steps, ok: true } };
}

async function repoInstall(body, root) {
  const cwd = body.path || root;

  // Detect package manager and install
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
    const r = await runShell("npm ci || npm install", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "npm", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
    const r = await runShell("yarn install --frozen-lockfile || yarn install", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "yarn", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    const r = await runShell("pnpm install --frozen-lockfile || pnpm install", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "pnpm", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "requirements.txt"))) {
    const r = await runShell("pip install -r requirements.txt", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "pip", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    const r = await runShell("pip install -e . 2>/dev/null || pip install .", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "pip/pyproject", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    const r = await runShell("cargo build", cwd, 600000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "cargo", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    const r = await runShell("go mod download", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "go", ...r } };
  }
  if (fs.existsSync(path.join(cwd, "Gemfile"))) {
    const r = await runShell("bundle install", cwd, 300000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { manager: "bundler", ...r } };
  }
  return { status: 200, body: { manager: "none", message: "No recognized package manager found" } };
}

async function repoBuild(body, root) {
  const cwd = body.path || root;
  const pkg = path.join(cwd, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
      if (p.scripts && p.scripts.build) {
        const r = await runShell("npm run build", cwd, 600000);
        return { status: r.exit_code === 0 ? 200 : 500, body: { script: "npm run build", ...r } };
      }
    } catch {}
  }
  if (fs.existsSync(path.join(cwd, "Makefile"))) {
    const r = await runShell("make", cwd, 600000);
    return { status: r.exit_code === 0 ? 200 : 500, body: { script: "make", ...r } };
  }
  return { status: 200, body: { script: "none", message: "No build script found" } };
}

async function repoDetect(body, root) {
  const cwd = body.path || root;
  const info = {
    path: cwd,
    has_git: fs.existsSync(path.join(cwd, ".git")),
    languages: [],
    package_managers: [],
    frameworks: [],
  };

  // Detect languages and frameworks
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    info.languages.push("javascript", "typescript");
    info.package_managers.push("npm");
    try {
      const p = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      const deps = { ...p.dependencies, ...p.devDependencies };
      if (deps.react) info.frameworks.push("react");
      if (deps.vue) info.frameworks.push("vue");
      if (deps.next) info.frameworks.push("nextjs");
      if (deps.express) info.frameworks.push("express");
      if (deps.tauri) info.frameworks.push("tauri");
    } catch {}
  }
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) { info.languages.push("rust"); info.package_managers.push("cargo"); }
  if (fs.existsSync(path.join(cwd, "go.mod"))) { info.languages.push("go"); info.package_managers.push("go"); }
  if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) { info.languages.push("python"); info.package_managers.push("pip"); }
  if (fs.existsSync(path.join(cwd, "Gemfile"))) { info.languages.push("ruby"); info.package_managers.push("bundler"); }
  if (fs.existsSync(path.join(cwd, "pom.xml")) || fs.existsSync(path.join(cwd, "build.gradle"))) { info.languages.push("java"); }

  return { status: 200, body: info };
}

module.exports = { handleRoute };

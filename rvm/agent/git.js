"use strict";
// Git operations module — clone, pull, push, status, diff, checkout, log, etc.
// Maps to official devin-remote git.rs + git_creds.rs routes.

const { runShell } = require("./core.js");
const path = require("path");

async function handleRoute(route, method, body, root) {
  const sub = route.replace("/api/git/", "");

  switch (sub) {
    case "status": return gitStatus(body, root);
    case "changes": return gitChanges(body, root);
    case "file-diff": return gitFileDiff(body, root);
    case "clone": return gitClone(body, root);
    case "pull": return gitPull(body, root);
    case "push": return gitPush(body, root);
    case "diff": return gitDiff(body, root);
    case "log": return gitLog(body, root);
    case "checkout": return gitCheckout(body, root);
    case "branch": return gitBranch(body, root);
    case "commit": return gitCommit(body, root);
    case "add": return gitAdd(body, root);
    case "reset": return gitReset(body, root);
    case "stash": return gitStash(body, root);
    case "fetch": return gitFetch(body, root);
    case "merge": return gitMerge(body, root);
    case "rebase": return gitRebase(body, root);
    case "remote": return gitRemote(body, root);
    case "tag": return gitTag(body, root);
    case "blame": return gitBlame(body, root);
    case "show": return gitShow(body, root);
    case "rev-parse": return gitRevParse(body, root);
    case "config": return gitConfig(body, root);
    case "creds/store": return gitCredsStore(body);
    case "creds/helper": return gitCredsHelper(body);
    default:
      return { status: 404, body: { error: `unknown git route: ${sub}` } };
  }
}

function parseGitNumstat(output) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split("\t");
    const additions = fields[0] === "-" ? 0 : Number.parseInt(fields[0], 10) || 0;
    const deletions = fields[1] === "-" ? 0 : Number.parseInt(fields[1], 10) || 0;
    const rawPath = fields.slice(2).join("\t");
    return { additions, deletions, path: normalizeRenamePath(rawPath) };
  });
}

function parseGitNameStatus(output) {
  const statuses = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split("\t");
    const status = fields[0] || "";
    const code = status[0];
    const paths = fields.slice(1);
    const path = code === "R" ? (paths[paths.length - 1] || "") : (paths[0] || "");
    if (!path) continue;
    statuses.set(normalizeRenamePath(path), code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified");
  }
  return statuses;
}

function findRenameSource(output, target) {
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split("\t");
    if (fields[0] && fields[0][0] === "R" && fields[fields.length - 1] === target) {
      return fields[fields.length - 2] || null;
    }
  }
  return null;
}

function normalizeRenamePath(value) {
  const pathValue = String(value || "");
  const braced = pathValue.match(/^\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[2]}${braced[3]}`;
  const rename = pathValue.match(/^(.*) => (.*)$/);
  if (!rename) return pathValue;
  return rename[2].replace(/^\{(.*)\}$/, "$1");
}

function validRepoPath(value) {
  const candidate = String(value || "");
  if (!candidate || candidate.includes("\0") || path.isAbsolute(candidate)) return false;
  const parts = candidate.replace(/\\/g, "/").split("/");
  return !parts.includes("..");
}

async function gitRepoCheck(cwd) {
  return runShell("git rev-parse --is-inside-work-tree", cwd, 10000);
}

async function gitChanges(body, root) {
  const cwd = body.cwd || root;
  const base = body.base || "HEAD";
  if (String(base).startsWith("-")) {
    return { status: 400, body: { error: "invalid base" } };
  }
  const repo = await gitRepoCheck(cwd);
  if (repo.exit_code !== 0 || repo.stdout.trim() !== "true") {
    return { status: 400, body: { error: "not a git repository" } };
  }
  const [numstat, nameStatus, branch, untracked] = await Promise.all([
    runShell(`git -c core.quotepath=off diff --numstat -M ${shq(base)}`, cwd, 30000),
    runShell(`git -c core.quotepath=off diff --name-status -M ${shq(base)}`, cwd, 30000),
    runShell("git branch --show-current", cwd, 10000),
    runShell("git -c core.quotepath=off ls-files --others --exclude-standard", cwd, 30000),
  ]);
  if (numstat.exit_code !== 0 || nameStatus.exit_code !== 0) {
    return { status: 400, body: { error: (numstat.stderr || nameStatus.stderr || "invalid git base").trim() } };
  }
  const types = parseGitNameStatus(nameStatus.stdout);
  const files = parseGitNumstat(numstat.stdout).map((entry) => ({
    path: entry.path,
    changeType: types.get(entry.path) || "modified",
    additions: entry.additions,
    deletions: entry.deletions,
  }));
  for (const filePath of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
    const lineCount = await runShell(`wc -l -- ${shq(filePath)}`, cwd, 10000);
    const match = /^(\d+)/.exec(lineCount.stdout.trim());
    files.push({
      path: filePath,
      changeType: "added",
      additions: match ? Number.parseInt(match[1], 10) : 0,
      deletions: 0,
    });
  }
  return {
    status: 200,
    body: { base, branch: branch.stdout.trim(), files },
  };
}

async function gitFileDiff(body, root) {
  const cwd = body.cwd || root;
  const base = body.base || "HEAD";
  const filePath = body.path;
  if (String(base).startsWith("-")) {
    return { status: 400, body: { error: "invalid base" } };
  }
  if (!validRepoPath(filePath)) return { status: 400, body: { error: "path must be a repository-relative path" } };
  const repo = await gitRepoCheck(cwd);
  if (repo.exit_code !== 0 || repo.stdout.trim() !== "true") {
    return { status: 400, body: { error: "not a git repository" } };
  }
  const allNameStatus = await runShell(`git -c core.quotepath=off diff --name-status -M ${shq(base)}`, cwd, 10000);
  if (allNameStatus.exit_code !== 0) {
    return { status: 400, body: { error: (allNameStatus.stderr || "invalid git base").trim() } };
  }
  const nameStatus = await runShell(`git -c core.quotepath=off diff --name-status -M ${shq(base)} -- ${shq(filePath)}`, cwd, 10000);
  const tracked = await runShell(`git -c core.quotepath=off ls-files --error-unmatch -- ${shq(filePath)}`, cwd, 10000);
  const renameSource = findRenameSource(allNameStatus.stdout, filePath);
  const isTracked = tracked.exit_code === 0 || nameStatus.stdout.trim().length > 0 || !!renameSource;
  const command = isTracked
    ? `git -c core.quotepath=off diff -M ${shq(base)} -- ${renameSource ? `${shq(renameSource)} ${shq(filePath)}` : shq(filePath)}`
    : `git -c core.quotepath=off diff --no-index -- /dev/null ${shq(filePath)}`;
  const result = await runShell(command, cwd, 30000);
  if (!isTracked && result.exit_code > 1) {
    return { status: 500, body: { error: result.stderr || "unable to read file diff" } };
  }
  if (isTracked && result.exit_code !== 0) {
    return { status: 400, body: { error: (result.stderr || "invalid git base").trim() } };
  }
  const types = parseGitNameStatus(allNameStatus.stdout);
  let changeType = types.get(filePath) || (isTracked ? "modified" : "added");
  const maxDiffBytes = 500 * 1024;
  const diffBytes = Buffer.byteLength(result.stdout, "utf8");
  const truncated = diffBytes > maxDiffBytes;
  const diff = truncated ? Buffer.from(result.stdout, "utf8").subarray(0, maxDiffBytes).toString("utf8") : result.stdout;
  return {
    status: 200,
    body: { path: filePath, changeType, diff, ...(truncated ? { truncated: true } : {}) },
  };
}

async function gitStatus(body, root) {
  const cwd = body.cwd || body.path || root;
  const r = await runShell("git status --porcelain -b", cwd, 15000);
  const lines = r.stdout.split("\n").filter(Boolean);
  const branch = lines.length > 0 && lines[0].startsWith("## ") ? lines[0].slice(3) : "";
  const files = lines.slice(1).map((l) => ({
    status: l.slice(0, 2).trim(),
    path: l.slice(3),
  }));
  const short = await runShell("git diff --stat HEAD 2>/dev/null", cwd, 10000);
  const untracked = await runShell("git ls-files --others --exclude-standard", cwd, 10000);
  return {
    status: 200,
    body: {
      branch,
      files,
      short_status: r.stdout.trim(),
      has_uncommitted: files.length > 0,
      has_untracked: untracked.stdout.trim().length > 0,
      diff_count: files.length,
      in_sync: !branch.includes("["),
    },
  };
}

async function gitClone(body, root) {
  const { url, dest, branch, depth } = body;
  if (!url) return { status: 400, body: { error: "url required" } };
  const target = dest || path.join(root, path.basename(url, ".git"));
  let cmd = `git clone`;
  if (branch) cmd += ` -b ${shq(branch)}`;
  if (depth) cmd += ` --depth ${depth}`;
  cmd += ` ${shq(url)} ${shq(target)}`;
  const r = await runShell(cmd, root, 300000);
  return { status: r.exit_code === 0 ? 200 : 500, body: { ...r, path: target } };
}

async function gitPull(body, root) {
  const cwd = body.cwd || body.path || root;
  const remote = body.remote || "origin";
  const branch = body.branch || "";
  const cmd = branch ? `git pull ${shq(remote)} ${shq(branch)}` : `git pull ${shq(remote)}`;
  const r = await runShell(cmd, cwd, 120000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitPush(body, root) {
  const cwd = body.cwd || body.path || root;
  const remote = body.remote || "origin";
  const branch = body.branch || "";
  const force = body.force ? "--force-with-lease" : "";
  const cmd = `git push ${force} ${shq(remote)} ${branch ? shq(branch) : ""}`.trim();
  const r = await runShell(cmd, cwd, 120000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitDiff(body, root) {
  const cwd = body.cwd || body.path || root;
  const ref1 = body.ref || body.base || "";
  const ref2 = body.target || "";
  const staged = body.staged ? "--cached" : "";
  const stat = body.stat ? "--stat" : "";
  const cmd = `git diff ${staged} ${stat} ${shq(ref1)} ${ref2 ? shq(ref2) : ""}`.trim();
  const r = await runShell(cmd, cwd, 30000);
  return { status: 200, body: { diff: r.stdout, exit_code: r.exit_code } };
}

async function gitLog(body, root) {
  const cwd = body.cwd || body.path || root;
  const n = body.n || body.count || 20;
  const format = body.format || "%H|%an|%ae|%ai|%s";
  const cmd = `git log -${n} --format="${format}"`;
  const r = await runShell(cmd, cwd, 15000);
  const commits = r.stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, author, email, date, ...msg] = line.split("|");
    return { hash, author, email, date, message: msg.join("|") };
  });
  return { status: 200, body: { commits, count: commits.length } };
}

async function gitCheckout(body, root) {
  const cwd = body.cwd || body.path || root;
  const { ref: gitRef, create } = body;
  if (!gitRef) return { status: 400, body: { error: "ref required" } };
  const cmd = create ? `git checkout -b ${shq(gitRef)}` : `git checkout ${shq(gitRef)}`;
  const r = await runShell(cmd, cwd, 30000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitBranch(body, root) {
  const cwd = body.cwd || body.path || root;
  const { list, delete: del, name, all } = body;
  if (del && name) {
    const r = await runShell(`git branch -D ${shq(name)}`, cwd, 10000);
    return { status: r.exit_code === 0 ? 200 : 500, body: r };
  }
  const flag = all ? "-a" : "";
  const r = await runShell(`git branch ${flag} --format='%(refname:short)'`, cwd, 10000);
  const branches = r.stdout.split("\n").filter(Boolean);
  const current = await runShell("git branch --show-current", cwd, 5000);
  return { status: 200, body: { branches, current: current.stdout.trim() } };
}

async function gitCommit(body, root) {
  const cwd = body.cwd || body.path || root;
  const { message, all } = body;
  if (!message) return { status: 400, body: { error: "message required" } };
  const allFlag = all ? "-a" : "";
  const r = await runShell(`git commit ${allFlag} -m ${shq(message)}`, cwd, 30000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitAdd(body, root) {
  const cwd = body.cwd || body.path || root;
  const { files, all } = body;
  const cmd = all ? "git add -A" : `git add ${(files || []).map(shq).join(" ")}`;
  const r = await runShell(cmd, cwd, 15000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitReset(body, root) {
  const cwd = body.cwd || body.path || root;
  const { ref: gitRef, hard } = body;
  const mode = hard ? "--hard" : "--mixed";
  const cmd = gitRef ? `git reset ${mode} ${shq(gitRef)}` : `git reset ${mode}`;
  const r = await runShell(cmd, cwd, 15000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitStash(body, root) {
  const cwd = body.cwd || body.path || root;
  const { action } = body; // push, pop, list, drop
  const cmd = `git stash ${action || "push"}`;
  const r = await runShell(cmd, cwd, 15000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitFetch(body, root) {
  const cwd = body.cwd || body.path || root;
  const remote = body.remote || "--all";
  const prune = body.prune ? "--prune" : "";
  const cmd = `git fetch ${remote} ${prune}`.trim();
  const r = await runShell(cmd, cwd, 120000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitMerge(body, root) {
  const cwd = body.cwd || body.path || root;
  const { ref: gitRef, no_ff } = body;
  if (!gitRef) return { status: 400, body: { error: "ref required" } };
  const cmd = `git merge ${no_ff ? "--no-ff" : ""} ${shq(gitRef)}`;
  const r = await runShell(cmd, cwd, 60000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitRebase(body, root) {
  const cwd = body.cwd || body.path || root;
  const { ref: gitRef, interactive, abort, continue: cont } = body;
  let cmd;
  if (abort) cmd = "git rebase --abort";
  else if (cont) cmd = "git rebase --continue";
  else if (gitRef) cmd = `git rebase ${interactive ? "-i" : ""} ${shq(gitRef)}`;
  else return { status: 400, body: { error: "ref, abort, or continue required" } };
  const r = await runShell(cmd, cwd, 60000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

async function gitRemote(body, root) {
  const cwd = body.cwd || body.path || root;
  const { action, name, url } = body;
  if (action === "add" && name && url) {
    const r = await runShell(`git remote add ${shq(name)} ${shq(url)}`, cwd, 10000);
    return { status: r.exit_code === 0 ? 200 : 500, body: r };
  }
  if (action === "remove" && name) {
    const r = await runShell(`git remote remove ${shq(name)}`, cwd, 10000);
    return { status: r.exit_code === 0 ? 200 : 500, body: r };
  }
  const r = await runShell("git remote -v", cwd, 10000);
  return { status: 200, body: { remotes: r.stdout.trim() } };
}

async function gitTag(body, root) {
  const cwd = body.cwd || body.path || root;
  const { name, message, delete: del } = body;
  if (del && name) {
    const r = await runShell(`git tag -d ${shq(name)}`, cwd, 10000);
    return { status: r.exit_code === 0 ? 200 : 500, body: r };
  }
  if (name) {
    const cmd = message ? `git tag -a ${shq(name)} -m ${shq(message)}` : `git tag ${shq(name)}`;
    const r = await runShell(cmd, cwd, 10000);
    return { status: r.exit_code === 0 ? 200 : 500, body: r };
  }
  const r = await runShell("git tag -l", cwd, 10000);
  return { status: 200, body: { tags: r.stdout.split("\n").filter(Boolean) } };
}

async function gitBlame(body, root) {
  const cwd = body.cwd || body.path || root;
  const { file } = body;
  if (!file) return { status: 400, body: { error: "file required" } };
  const r = await runShell(`git blame --porcelain ${shq(file)}`, cwd, 30000);
  return { status: 200, body: { blame: r.stdout } };
}

async function gitShow(body, root) {
  const cwd = body.cwd || body.path || root;
  const { ref: gitRef } = body;
  const r = await runShell(`git show ${shq(gitRef || "HEAD")}`, cwd, 30000);
  return { status: 200, body: { show: r.stdout } };
}

async function gitRevParse(body, root) {
  const cwd = body.cwd || body.path || root;
  const { ref: gitRef } = body;
  const r = await runShell(`git rev-parse ${shq(gitRef || "HEAD")}`, cwd, 5000);
  return { status: 200, body: { sha: r.stdout.trim() } };
}

async function gitConfig(body, root) {
  const cwd = body.cwd || body.path || root;
  const { key, value, global: isGlobal } = body;
  if (key && value !== undefined) {
    const scope = isGlobal ? "--global" : "--local";
    const r = await runShell(`git config ${scope} ${shq(key)} ${shq(value)}`, cwd, 5000);
    return { status: r.exit_code === 0 ? 200 : 500, body: r };
  }
  if (key) {
    const r = await runShell(`git config --get ${shq(key)}`, cwd, 5000);
    return { status: 200, body: { key, value: r.stdout.trim() } };
  }
  const r = await runShell("git config --list --local 2>/dev/null", cwd, 5000);
  return { status: 200, body: { config: r.stdout.trim() } };
}

async function gitCredsStore(body) {
  const { protocol, host, username, password } = body;
  if (!host || !username) return { status: 400, body: { error: "host and username required" } };
  const input = `protocol=${protocol || "https"}\nhost=${host}\nusername=${username}\npassword=${password || ""}\n\n`;
  const r = await runShell(`echo ${shq(input)} | git credential-store store`, undefined, 10000);
  return { status: r.exit_code === 0 ? 200 : 500, body: { ok: r.exit_code === 0 } };
}

async function gitCredsHelper(body) {
  const { helper } = body; // "store", "cache", etc.
  const r = await runShell(`git config --global credential.helper ${shq(helper || "store")}`, undefined, 5000);
  return { status: r.exit_code === 0 ? 200 : 500, body: r };
}

function shq(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
}

module.exports = {
  handleRoute,
  parseGitNumstat,
  parseGitNameStatus,
  normalizeRenamePath,
  findRenameSource,
};

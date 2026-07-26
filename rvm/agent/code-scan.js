"use strict";
// Code scanning module — pattern matching, security scanning
// Maps to official devin-remote code_scans.rs

const { runShell } = require("./core.js");

async function handleRoute(body, root) {
  const { pattern, path: scanPath, type: scanType, exclude } = body;
  const cwd = scanPath || root;
  const isWin = process.platform === "win32";

  if (scanType === "security") {
    return securityScan(cwd);
  }

  if (!pattern) return { status: 400, body: { error: "pattern required" } };

  const excludeArgs = (exclude || ["node_modules", ".git", "dist", "build", "__pycache__"])
    .map((e) => isWin ? "" : `--exclude-dir=${shq(e)}`)
    .join(" ");

  const cmd = isWin
    ? `Select-String -Path '${cwd}\\*' -Pattern '${pattern}' -Recurse -List | Select-Object -First 500 | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`
    : `grep -rn ${excludeArgs} ${shq(pattern)} ${shq(cwd)} 2>/dev/null | head -500`;

  const r = await runShell(cmd, root, 60000);
  const matches = r.stdout.split("\n").filter(Boolean).map((line) => {
    const parts = line.match(/^(.+?):(\d+):(.*)$/);
    if (parts) return { file: parts[1], line: parseInt(parts[2]), content: parts[3].trim() };
    return { raw: line };
  });
  return { status: 200, body: { pattern, matches, count: matches.length } };
}

async function securityScan(cwd) {
  const patterns = [
    { name: "hardcoded_secret", pattern: "(password|secret|api_key|token|private_key)\\s*[=:]\\s*['\"]" },
    { name: "sql_injection", pattern: "(exec|execute|query)\\s*\\(.*\\+|f['\"].*\\{.*\\}.*SELECT|WHERE" },
    { name: "eval_usage", pattern: "\\beval\\s*\\(" },
    { name: "shell_injection", pattern: "child_process|subprocess\\.call|os\\.system|Runtime\\.exec" },
  ];

  const findings = [];
  for (const p of patterns) {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? `Select-String -Path '${cwd}\\*' -Pattern '${p.pattern}' -Recurse -List | Select-Object -First 50`
      : `grep -rn --include='*.js' --include='*.ts' --include='*.py' --include='*.java' --include='*.rb' --exclude-dir=node_modules --exclude-dir=.git ${shq(p.pattern)} ${shq(cwd)} 2>/dev/null | head -50`;
    const r = await runShell(cmd, cwd, 30000);
    if (r.stdout.trim()) {
      findings.push({
        type: p.name,
        count: r.stdout.split("\n").filter(Boolean).length,
        matches: r.stdout.split("\n").filter(Boolean).slice(0, 10),
      });
    }
  }
  return { status: 200, body: { type: "security", findings, total: findings.reduce((s, f) => s + f.count, 0) } };
}

function shq(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
}

module.exports = { handleRoute };

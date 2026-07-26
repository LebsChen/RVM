#!/usr/bin/env node
/**
 * RVM (Remote Virtual Machines) Docker Test Suite
 * Validates agent HTTP server, Authentication, Shell Execution, File I/O, Git, and Capability APIs.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const TEST_PORT = Number(process.env.TEST_PORT || 9899);
const TEST_TOKEN = process.env.TEST_TOKEN || "test-secret-token-2026";
const TEST_ROOT = path.join(os.tmpdir(), "rvm-docker-test-workspace");

// Ensure clean test directory
try {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
} catch {}

let passed = 0;
let failed = 0;
const results = [];

function log(msg) {
  console.log(`[RVM TEST] ${msg}`);
}

function assert(condition, testName, details = "") {
  if (condition) {
    passed++;
    results.push({ name: testName, ok: true, details });
    console.log(`  ✓ PASSED: ${testName}`);
  } else {
    failed++;
    results.push({ name: testName, ok: false, details });
    console.error(`  ✗ FAILED: ${testName} - ${details}`);
  }
}

function makeRequest(method, endpoint, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const dataString = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    
    const reqHeaders = {
      ...headers,
    };
    if (dataString && !reqHeaders["Content-Type"]) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(dataString);
    }

    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: endpoint,
      method: method,
      headers: reqHeaders,
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    if (dataString) {
      req.write(dataString);
    }
    req.end();
  });
}

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await makeRequest("GET", "/health");
      if (res.statusCode === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function runTestSuite() {
  log("==================================================");
  log(" Starting RVM Container & Agent Automated Tests   ");
  log(` Port: ${TEST_PORT} | Workspace: ${TEST_ROOT}     `);
  log("==================================================");

  // 1. Healthcheck Unauthenticated
  log("\n1. Testing Health Endpoint (/health)");
  try {
    const res = await makeRequest("GET", "/health");
    assert(res.statusCode === 200, "Health endpoint status 200", `got ${res.statusCode}`);
    assert(res.body && res.body.status === "ok", "Health endpoint status body ok", JSON.stringify(res.body));
    assert(res.body && res.body.service === "dev-agent", "Service identified as dev-agent");
  } catch (e) {
    assert(false, "Health endpoint reachable", e.message);
  }

  // 2. Authentication Enforcement
  log("\n2. Testing Authentication Guard");
  try {
    const unauthRes = await makeRequest("POST", "/api/exec", {}, { cmd: "echo test" });
    assert(unauthRes.statusCode === 401, "Reject unauthenticated requests with 401", `got ${unauthRes.statusCode}`);
  } catch (e) {
    assert(false, "Authentication guard test error", e.message);
  }

  const authHeader = { "Authorization": `Bearer ${TEST_TOKEN}` };

  // 3. Shell Command Execution
  log("\n3. Testing Shell Execution API (/api/exec)");
  try {
    const execRes = await makeRequest("POST", "/api/exec", authHeader, { cmd: "echo 'RVM_DOCKER_SUCCESS'" });
    assert(execRes.statusCode === 200, "Exec status 200", `got ${execRes.statusCode}`);
    assert(
      execRes.body && execRes.body.result && execRes.body.result.stdout && execRes.body.result.stdout.includes("RVM_DOCKER_SUCCESS"),
      "Exec returned correct stdout",
      JSON.stringify(execRes.body)
    );
  } catch (e) {
    assert(false, "Exec endpoint test error", e.message);
  }

  // 4. Custom Working Directory Execution
  log("\n4. Testing CWD Execution");
  try {
    const cwdRes = await makeRequest("POST", "/api/exec", authHeader, { cmd: "pwd", cwd: TEST_ROOT });
    assert(cwdRes.statusCode === 200, "Exec with CWD status 200");
    const outputCwd = cwdRes.body && cwdRes.body.result && cwdRes.body.result.stdout ? cwdRes.body.result.stdout.trim() : "";
    assert(outputCwd === TEST_ROOT || outputCwd.includes("rvm-docker-test"), "Command executed in target CWD", `stdout: ${outputCwd}`);
  } catch (e) {
    assert(false, "CWD execution test error", e.message);
  }

  // 5. File System Operations
  log("\n5. Testing File Write and Read APIs");
  const testFilePath = path.join(TEST_ROOT, "docker-test-sample.txt");
  const sampleContent = "RVM Docker Container File I/O Verification\nTimestamp: " + new Date().toISOString();
  
  try {
    const writeRes = await makeRequest("POST", "/api/write", authHeader, { path: testFilePath, content: sampleContent });
    assert(writeRes.statusCode === 200, "File write status 200", `got ${writeRes.statusCode}`);

    const readRes = await makeRequest("POST", "/api/read", authHeader, { path: testFilePath });
    assert(readRes.statusCode === 200, "File read status 200");
    assert(readRes.body && readRes.body.content === sampleContent, "Read file content matches written content");
  } catch (e) {
    assert(false, "File I/O test error", e.message);
  }

  // 6. File List & Search (Find & Grep)
  log("\n6. Testing File Search (Find & Grep)");
  try {
    const findRes = await makeRequest("POST", "/api/find", authHeader, { name: "docker-test-sample.txt", path: TEST_ROOT });
    assert(findRes.statusCode === 200, "Find API status 200");
    assert(findRes.body && findRes.body.count >= 1, "Find API returned created file match");

    const grepRes = await makeRequest("POST", "/api/grep", authHeader, { pattern: "Verification", path: TEST_ROOT });
    assert(grepRes.statusCode === 200, "Grep API status 200");
    assert(grepRes.body && grepRes.body.count >= 1, "Grep API matched content in file");
  } catch (e) {
    assert(false, "Search test error", e.message);
  }

  // 7. Git Operations Test
  log("\n7. Testing Git Integration");
  try {
    const gitInit = await makeRequest("POST", "/api/exec", authHeader, { cmd: "git init && git status", cwd: TEST_ROOT });
    assert(gitInit.statusCode === 200, "Git command status 200");
    assert(
      gitInit.body && gitInit.body.result && gitInit.body.result.stdout && (gitInit.body.result.stdout.includes("branch") || gitInit.body.result.stdout.includes("Initialized")),
      "Git initialized and returned repository status"
    );
  } catch (e) {
    assert(false, "Git test error", e.message);
  }

  // 8. MCP Protocol Endpoint Tests
  log("\n8. Testing MCP Protocol & Tools (/mcp)");
  try {
    // 8a. MCP initialize
    const initRes = await makeRequest("POST", "/mcp", authHeader, {
      jsonrpc: "2.0",
      id: 101,
      method: "initialize",
      params: {}
    });
    assert(initRes.statusCode === 200, "MCP initialize HTTP 200", `got ${initRes.statusCode}`);
    assert(initRes.body && initRes.body.result && initRes.body.result.serverInfo?.name === "rvm", "MCP serverInfo name is 'rvm'", JSON.stringify(initRes.body));

    // 8b. MCP tools/list
    const toolsRes = await makeRequest("POST", "/mcp", authHeader, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/list",
      params: {}
    });
    assert(toolsRes.statusCode === 200, "MCP tools/list HTTP 200");
    assert(Array.isArray(toolsRes.body?.result?.tools), "MCP returned tools array");
    const toolNames = (toolsRes.body?.result?.tools || []).map(t => t.name);
    assert(toolNames.includes("shell_exec") && toolNames.includes("read_file") && toolNames.includes("system_info"), "MCP tools array includes core tools (shell_exec, read_file, system_info)", toolNames.join(", "));

    // 8c. MCP tools/call system_info
    const sysInfoRes = await makeRequest("POST", "/mcp", authHeader, {
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: { name: "system_info", arguments: {} }
    });
    assert(sysInfoRes.statusCode === 200, "MCP system_info call HTTP 200");
    assert(sysInfoRes.body?.result?.content?.[0]?.text?.includes("platform"), "MCP system_info returned system details", JSON.stringify(sysInfoRes.body));

    // 8d. MCP tools/call write_file & read_file
    const mcpFilePath = path.join(TEST_ROOT, "mcp-write-test.txt");
    const mcpWriteRes = await makeRequest("POST", "/mcp", authHeader, {
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: { name: "write_file", arguments: { path: mcpFilePath, content: "MCP_FILE_SUCCESS" } }
    });
    assert(mcpWriteRes.statusCode === 200, "MCP write_file call HTTP 200");

    const mcpReadRes = await makeRequest("POST", "/mcp", authHeader, {
      jsonrpc: "2.0",
      id: 105,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: mcpFilePath } }
    });
    assert(mcpReadRes.statusCode === 200, "MCP read_file call HTTP 200");
    assert(mcpReadRes.body?.result?.content?.[0]?.text === "MCP_FILE_SUCCESS", "MCP read_file returned written content");

    // 8e. MCP tools/call shell_exec
    const mcpExecRes = await makeRequest("POST", "/mcp", authHeader, {
      jsonrpc: "2.0",
      id: 106,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "echo 'MCP_SHELL_TEST_OK'" } }
    });
    assert(mcpExecRes.statusCode === 200, "MCP shell_exec call HTTP 200");
    assert(mcpExecRes.body?.result?.content?.[0]?.text?.includes("MCP_SHELL_TEST_OK"), "MCP shell_exec stdout correct", JSON.stringify(mcpExecRes.body));
  } catch (e) {
    assert(false, "MCP endpoint test error", e.message);
  }

  // 9. Capabilities & Extended RVM API Tests
  log("\n9. Testing Capabilities & Extended RVM APIs");
  try {
    const capRes = await makeRequest("GET", "/api/capabilities", authHeader);
    assert(capRes.statusCode === 200, "Capabilities API status 200");
    assert(capRes.body && capRes.body.version && capRes.body.endpoints, "Capabilities response contains version and endpoints", JSON.stringify(capRes.body));

    const lsRes = await makeRequest("POST", "/api/ls", authHeader, { path: TEST_ROOT });
    assert(lsRes.statusCode === 200, "Directory listing API (/api/ls) status 200");

    const scratchWriteRes = await makeRequest("POST", "/api/scratchpad/write", authHeader, { key: "docker-test-key", content: "RVM Scratchpad Test Content" });
    assert(scratchWriteRes.statusCode === 200, "Scratchpad write API status 200");

    const scratchReadRes = await makeRequest("POST", "/api/scratchpad/read", authHeader, { key: "docker-test-key" });
    assert(scratchReadRes.statusCode === 200, "Scratchpad read API status 200");
    assert(scratchReadRes.body && scratchReadRes.body.content === "RVM Scratchpad Test Content", "Scratchpad content matches");
  } catch (e) {
    assert(false, "Extended API test error", e.message);
  }

  // Summary Report
  log("\n==================================================");
  log(` Test Execution Summary: ${passed} Passed | ${failed} Failed `);
  log("==================================================");

  // Cleanup test workspace
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}

  return failed === 0;
}

async function main() {
  log("Launching RVM Agent Process...");
  const agentPath = path.join(__dirname, "agent.js");

  const agentProcess = spawn(process.execPath, [agentPath], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      TOKEN: TEST_TOKEN,
      ROOT: TEST_ROOT,
    },
    stdio: "pipe",
  });

  agentProcess.stdout.on("data", (d) => {
    // Optionally trace agent stdout: process.stdout.write(`[AGENT] ${d}`);
  });

  agentProcess.stderr.on("data", (d) => {
    // process.stderr.write(`[AGENT ERR] ${d}`);
  });

  try {
    const isReady = await waitForServer(30);
    if (!isReady) {
      log("FATAL: RVM Agent server failed to become ready within timeout.");
      agentProcess.kill();
      process.exit(1);
    }

    log("RVM Agent process is UP and listening!");
    const allPassed = await runTestSuite();

    log("Shutting down RVM Agent process...");
    agentProcess.kill("SIGTERM");

    if (allPassed) {
      log("All RVM Docker tests PASSED successfully! (Exit Code 0)");
      process.exit(0);
    } else {
      log("Some RVM Docker tests FAILED! (Exit Code 1)");
      process.exit(1);
    }
  } catch (err) {
    log(`Unexpected test suite runner error: ${err.message}`);
    agentProcess.kill();
    process.exit(1);
  }
}

// Export for node execution or programmatic usage
if (require.main === module) {
  main();
} else {
  module.exports = { runTestSuite, makeRequest };
}

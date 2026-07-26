"use strict";
// Middleware module — pre/post tool hooks, session lifecycle
// Maps to official devin-remote middleware.rs + event_handler.rs

const hooks = {
  pre_tool: [],
  post_tool: [],
  session_start: [],
  user_prompt: [],
  post_agent_iteration: [],
};

const eventTypes = [
  "tool_start", "tool_end", "session_start", "session_end",
  "file_change", "command_exec", "error", "status_change",
  "agent_iteration", "user_message",
];

async function handleRoute(route, method, body) {
  const sub = route.replace("/api/middleware/", "");

  switch (sub) {
    case "pre-tool": return runHooks("pre_tool", body);
    case "post-tool": return runHooks("post_tool", body);
    case "session-start": return runHooks("session_start", body);
    case "user-prompt": return runHooks("user_prompt", body);
    case "post-agent-iteration": return runHooks("post_agent_iteration", body);
    case "register": return registerHook(body);
    case "list": return listHooks();
    default:
      return { status: 404, body: { error: `unknown middleware route: ${sub}` } };
  }
}

function runHooks(type, context) {
  const results = [];
  for (const hook of hooks[type] || []) {
    try {
      const result = hook.handler(context);
      results.push({ name: hook.name, result });
    } catch (e) {
      results.push({ name: hook.name, error: String(e.message || e) });
    }
  }
  return { status: 200, body: { type, results, hook_count: results.length, context } };
}

function registerHook(body) {
  const { type, name, action } = body;
  if (!type || !hooks[type]) {
    return { status: 400, body: { error: `invalid hook type: ${type}. Valid: ${Object.keys(hooks).join(", ")}` } };
  }
  if (!name) return { status: 400, body: { error: "name required" } };

  hooks[type].push({
    name,
    action: action || "log",
    handler: (ctx) => ({ action: action || "log", context_keys: Object.keys(ctx || {}) }),
  });

  return { status: 200, body: { ok: true, type, name, total: hooks[type].length } };
}

function listHooks() {
  const result = {};
  for (const [type, list] of Object.entries(hooks)) {
    result[type] = list.map((h) => ({ name: h.name, action: h.action }));
  }
  return { status: 200, body: result };
}

function getEventTypes() {
  return eventTypes;
}

module.exports = { handleRoute, getEventTypes };

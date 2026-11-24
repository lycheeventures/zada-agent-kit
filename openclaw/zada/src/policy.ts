// Decides, for one tool call, whether ZADA Work is asked first, and under which action name.
// Pure functions: no network, no OpenClaw imports, so the rules can be tested offline.

import { createHash } from "node:crypto";

export type ShellRule = { match: string; action: string };

export type Policy = {
  /** Tool-name patterns already checked somewhere else (a gateway that asks ZADA Work itself). */
  skip: string[];
  /** Extra tool-name patterns that only read, so they pass without asking. */
  read: string[];
  /** Extra tool-name patterns that are always asked, whatever the built-in rules say. */
  ask: string[];
  shell: {
    /** What happens to a shell command no rule names. "pass" is only safe inside a sandbox. */
    default: "ask" | "pass";
    /** Most dangerous first: the first rule that matches any part of the command decides. */
    rules: ShellRule[];
  };
};

export const DEFAULT_POLICY: Policy = { skip: [], read: [], ask: [], shell: { default: "ask", rules: [] } };

export type Verdict =
  | { kind: "pass"; why: "skipped" | "read" | "local" | "shell_pass" }
  | { kind: "ask"; action: string; description: string };

/** Built-in OpenClaw tools that stay inside the agent's own workspace, memory or screen. */
const LOCAL_TOOLS = new Set([
  "read", "write", "edit", "apply_patch", "process",
  "memory_search", "memory_get",
  "sessions", "sessions_list", "sessions_history", "sessions_search", "sessions_send", "sessions_spawn",
  "sessions_yield", "subagents", "session_status", "conversations_list", "suggest_task", "dismiss_task",
  "agents_list", "get_goal", "create_goal", "update_goal", "progress_card", "ask_user",
  "view_image", "image_generate", "music_generate", "video_generate", "tts", "pdf",
  "web_search", "x_search", "web_fetch", "canvas", "show_widget", "tool_search",
]);

const SHELL_TOOLS = new Set(["exec", "bash", "code_execution"]);

/** A tool or sub-action whose name starts like this only looks things up. */
const READ_NAME = /^(list|get|fetch|search|find|read|count|lookup|describe|view|show|whoami)(_|-|$)/;

export const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;
export const ACTION_MAX = 60;

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

export function matchesAny(name: string, globs: readonly string[]): boolean {
  return globs.some((glob) => typeof glob === "string" && glob.length > 0 && globToRegExp(glob).test(name));
}

/** One segment of an action id: lower case letters, digits and underscores only. */
export function segment(raw: string, max: number): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max).replace(/_+$/g, "");
  return clean || "call";
}

function firstSegment(raw: string, max: number): string {
  const clean = segment(raw, max);
  return /^[a-z]/.test(clean) ? clean : `tool_${clean}`.slice(0, max);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Splits `a && b ; c | d` so a dangerous command cannot hide behind a harmless one. */
export function splitCommand(command: string): string[] {
  return command.split(/&&|\|\||[;|\n&]/).map((part) => part.trim()).filter(Boolean);
}

/** The program and, if it runs a script, the script's file name. Never the arguments. */
export function commandLabel(command: string): string {
  const words = (splitCommand(command)[0] ?? "").split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const base = (word: string) => word.split("/").pop() ?? word;
  const program = base(words[0] ?? "");
  const script = words.slice(1).find((word) => /\.(py|sh|js|ts|rb|pl|php)$/.test(word));
  const label = script ? `${program} ${base(script)}` : program;
  return label.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 60);
}

function shellVerdict(agentId: string, params: Record<string, unknown>, policy: Policy): Verdict {
  const raw = params["command"] ?? params["cmd"];
  const command = typeof raw === "string" ? raw : "";
  const parts = splitCommand(command);
  for (const rule of policy.shell.rules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.match);
    } catch {
      continue; // a broken rule never widens access: the default below still applies
    }
    if (ACTION_RE.test(rule.action) && rule.action.length <= ACTION_MAX && parts.some((part) => pattern.test(part))) {
      return { kind: "ask", action: rule.action, description: `${agentId} wants to run a command (${commandLabel(command) || "shell"})` };
    }
  }
  // No readable command (for example code mode) is never waved through.
  if (policy.shell.default === "pass" && command) return { kind: "pass", why: "shell_pass" };
  return { kind: "ask", action: "shell.run", description: `${agentId} wants to run a command (${commandLabel(command) || "code"})` };
}

/** `server__tool` is how OpenClaw names a tool that comes from an MCP server. */
function mcpVerdict(agentId: string, toolName: string, forced: boolean): Verdict {
  const at = toolName.indexOf("__");
  const server = toolName.slice(0, at);
  const tool = toolName.slice(at + 2);
  if (!forced && READ_NAME.test(tool.toLowerCase())) return { kind: "pass", why: "read" };
  const action = `${firstSegment(server, 20)}.${segment(tool, 38)}`;
  return { kind: "ask", action, description: `${agentId} wants to use ${tool} on ${server}`.slice(0, 300) };
}

function builtinVerdict(agentId: string, toolName: string, params: Record<string, unknown>, forced: boolean): Verdict {
  const sub = typeof params["action"] === "string" ? (params["action"] as string) : "";
  if (!forced && sub && READ_NAME.test(sub.toLowerCase())) return { kind: "pass", why: "read" };
  const action = `${firstSegment(toolName, 20)}.${segment(sub || "call", 38)}`;
  const channel = typeof params["channel"] === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(params["channel"] as string) ? ` on ${params["channel"]}` : "";
  return { kind: "ask", action, description: `${agentId} wants to use ${toolName}${sub ? ` (${segment(sub, 38)})` : ""}${channel}`.slice(0, 300) };
}

export function classify(agentId: string, toolName: string, rawParams: unknown, policy: Policy = DEFAULT_POLICY): Verdict {
  const params = record(rawParams);
  if (matchesAny(toolName, policy.skip)) return { kind: "pass", why: "skipped" };
  const forced = matchesAny(toolName, policy.ask);
  if (!forced && matchesAny(toolName, policy.read)) return { kind: "pass", why: "read" };
  if (SHELL_TOOLS.has(toolName)) return shellVerdict(agentId, params, policy);
  if (toolName.includes("__")) return mcpVerdict(agentId, toolName, forced);
  if (!forced && LOCAL_TOOLS.has(toolName)) return { kind: "pass", why: "local" };
  return builtinVerdict(agentId, toolName, params, forced);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

/**
 * Same call on the same day, same id: asking again after the person approved returns that approval,
 * not a new request. The day is part of the id so an old answer is not reused for a repeat on a later day.
 */
export function requestId(agentId: string, toolName: string, params: unknown, day = ""): string {
  return createHash("sha256").update(agentId + toolName + JSON.stringify(stable(params ?? {})) + day).digest("hex").slice(0, 40);
}

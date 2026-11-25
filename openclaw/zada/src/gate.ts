// The gate: ask ZADA before a tool runs, tell ZADA what happened after.
// Nothing here imports OpenClaw, so the safety rules can be tested without a gateway.

import { randomBytes } from "node:crypto";
import { classify, requestId, DEFAULT_POLICY, type Policy, type ShellRule } from "./policy.ts";

export type AgentLink = { keyFile?: string; keyEnv?: string };

export type GateConfig = {
  endpoint: string;
  /** true: an agent with no ZADA key cannot do anything that needs asking. */
  required: boolean;
  /** How long a run started by a person waits for the approval before it is told to come back later. */
  waitSeconds: number;
  agents: Record<string, AgentLink>;
  policy: Policy;
};

export const DEFAULT_ENDPOINT = "https://mcp.zada.io/mcp";
export const MAX_WAIT_SECONDS = 540;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** Reads the operator's settings. A wrong value falls back to the stricter default, never a looser one. */
export function parseConfig(raw: unknown): GateConfig {
  const cfg = record(raw);
  const shell = record(cfg["shell"]);
  const rules: ShellRule[] = (Array.isArray(shell["rules"]) ? shell["rules"] : []).flatMap((rule) => {
    const r = record(rule);
    return typeof r["match"] === "string" && typeof r["action"] === "string" ? [{ match: r["match"], action: r["action"] }] : [];
  });
  const agents: Record<string, AgentLink> = {};
  for (const [id, value] of Object.entries(record(cfg["agents"]))) {
    const link = record(value);
    const keyFile = typeof link["keyFile"] === "string" && link["keyFile"] ? link["keyFile"] : undefined;
    const keyEnv = typeof link["keyEnv"] === "string" && link["keyEnv"] ? link["keyEnv"] : undefined;
    if (keyFile || keyEnv) agents[id] = { ...(keyFile ? { keyFile } : {}), ...(keyEnv ? { keyEnv } : {}) };
  }
  const endpoint = typeof cfg["endpoint"] === "string" && /^https:\/\//.test(cfg["endpoint"]) ? cfg["endpoint"] : DEFAULT_ENDPOINT;
  const wait = typeof cfg["waitSeconds"] === "number" && Number.isFinite(cfg["waitSeconds"]) ? cfg["waitSeconds"] : 60;
  return {
    endpoint,
    required: cfg["required"] === true,
    waitSeconds: Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(wait))),
    agents,
    policy: {
      skip: strings(cfg["skip"]),
      read: strings(cfg["read"]),
      ask: strings(cfg["ask"]),
      shell: { default: shell["default"] === "pass" ? "pass" : DEFAULT_POLICY.shell.default, rules },
    },
  };
}

export type ToolEvent = { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string };
export type AfterEvent = ToolEvent & { result?: unknown; error?: string };
export type ToolContext = { agentId?: string; trigger?: string; abortSignal?: AbortSignal };
export type BeforeResult = { block: true; blockReason: string } | undefined;

export type GateDeps = {
  /** The agent's ZADA key, or null when the agent is not connected. */
  key: (agentId: string) => Promise<string | null>;
  call: (endpoint: string, key: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: "debug" | "info" | "warn", message: string) => void;
};

export const MESSAGES = {
  unreachable: "ZADA could not be reached, so this action was not run.",
  unlinked: "This agent is not connected to ZADA, so it cannot do this. An administrator adds its ZADA key to the zada plugin settings.",
  noAgent: "The agent could not be identified, so this action was not run.",
  pending: "Waiting for approval in ZADA. Nothing was done. Tell the person it is waiting for them; run the same call again later and it runs once approved.",
  noPermission: "This agent has no permission for this yet. Nothing was done. Ask the person to give the permission in ZADA.",
  refused: "ZADA refused this action. Nothing was done.",
};

const block = (reason: string): BeforeResult => ({ block: true, blockReason: reason });
const PENDING = new Set(["pending_approval", "pending"]);
const REMEMBER_MS = 60 * 60 * 1000;
const REMEMBER_MAX = 2000;
const WAITING_MS = 24 * 60 * 60 * 1000;

export function createGate(config: GateConfig, deps: GateDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});
  /**
   * Asks still waiting for the person: call fingerprint -> the id it was asked under.
   * ZADA answers one id once. A new call gets a new id, so the same action can be done again later;
   * only a call whose approval is still open is asked again under its old id, to pick that approval up.
   * Kept in memory: after a gateway restart a waiting call is asked afresh.
   */
  const waiting = new Map<string, { id: string; at: number }>();
  const askId = (fingerprint: string) => {
    const kept = waiting.get(fingerprint);
    if (kept && now() - kept.at < WAITING_MS) return kept.id;
    return `${fingerprint.slice(0, 24)}${randomBytes(8).toString("hex")}`;
  };
  /** Allowed calls waiting for their outcome: call key -> intent. */
  const open = new Map<string, { agentId: string; intentId: string; at: number }>();

  const callKey = (agentId: string, event: ToolEvent) =>
    event.toolCallId ? `id:${event.toolCallId}` : `rq:${event.runId ?? ""}:${requestId(agentId, event.toolName, event.params)}`;

  function remember(key: string, agentId: string, intentId: string) {
    const t = now();
    for (const [k, v] of open) if (t - v.at > REMEMBER_MS || open.size >= REMEMBER_MAX) open.delete(k);
    open.set(key, { agentId, intentId, at: t });
  }

  function refusal(answer: Record<string, unknown>, decision: string, intentId?: string): BeforeResult {
    if (PENDING.has(decision)) return block(`${MESSAGES.pending}${intentId ? ` Reference: ${intentId}` : ""}`);
    if (decision === "no_mandate") return block(MESSAGES.noPermission);
    return block(typeof answer["message"] === "string" && answer["message"] ? answer["message"].slice(0, 400) : MESSAGES.refused);
  }

  async function before(event: ToolEvent, ctx: ToolContext): Promise<BeforeResult> {
    const agentId = ctx.agentId ?? "";
    // Not required and not connected: the plugin stays out of this agent's way entirely.
    if (!config.required && agentId && !Object.prototype.hasOwnProperty.call(config.agents, agentId)) return undefined;
    const verdict = classify(agentId || "The agent", event.toolName, event.params, config.policy);
    if (verdict.kind === "pass") {
      log("debug", `zada: ${agentId || "?"} ${event.toolName} passes (${verdict.why})`);
      return undefined;
    }
    if (!agentId) return block(MESSAGES.noAgent);
    log("debug", `zada: ${agentId} ${event.toolName} asks as ${verdict.action}`);
    try {
      const key = await deps.key(agentId);
      if (!key) return config.required ? block(MESSAGES.unlinked) : undefined;

      const fingerprint = requestId(agentId, event.toolName, event.params);
      const id = askId(fingerprint);
      let answer = await deps.call(config.endpoint, key, "zada_ask", {
        action: verdict.action,
        description: verdict.description,
        reference: event.toolName.slice(0, 120),
        request_id: id,
      }, ctx.abortSignal);
      let decision = typeof answer["decision"] === "string" ? answer["decision"] : "invalid";
      const intentId = typeof answer["intent_id"] === "string" ? answer["intent_id"] : undefined;

      // A person is in the conversation: give them a moment to approve, then carry on in the same run.
      const mayWait = config.waitSeconds > 0 && intentId && (ctx.trigger === undefined || ctx.trigger === "user");
      const deadline = now() + config.waitSeconds * 1000;
      while (PENDING.has(decision) && mayWait && now() < deadline) {
        if (ctx.abortSignal?.aborted) return block(MESSAGES.pending);
        const started = now();
        answer = await deps.call(config.endpoint, key, "zada_wait", { intent_id: intentId }, ctx.abortSignal);
        decision = typeof answer["decision"] === "string" ? answer["decision"] : typeof answer["status"] === "string" ? answer["status"] : "invalid";
        if (PENDING.has(decision) && now() - started < 2000) await sleep(2000);
      }

      if (PENDING.has(decision)) {
        for (const [k, v] of waiting) if (now() - v.at > WAITING_MS || waiting.size >= REMEMBER_MAX) waiting.delete(k);
        const kept = waiting.get(fingerprint);
        waiting.set(fingerprint, { id, at: kept && kept.id === id ? kept.at : now() });
      } else waiting.delete(fingerprint);

      if (decision === "allowed") {
        if (intentId) remember(callKey(agentId, event), agentId, intentId);
        return undefined;
      }
      return refusal(answer, decision, intentId);
    } catch {
      log("warn", `zada: could not ask ZADA for ${event.toolName}; blocked`);
      return block(MESSAGES.unreachable);
    }
  }

  async function after(event: AfterEvent, ctx: ToolContext): Promise<void> {
    const agentId = ctx.agentId ?? "";
    if (!agentId) return;
    const key = callKey(agentId, event);
    const entry = open.get(key);
    if (!entry) return;
    open.delete(key);
    // Neither a result nor an error is not proof of success: then no outcome is claimed.
    const failed = typeof event.error === "string" && event.error.length > 0 || record(event.result)["isError"] === true;
    const outcome = failed ? "failed" : event.result !== undefined ? "done" : undefined;
    try {
      const zadaKey = await deps.key(agentId);
      if (!zadaKey) throw new Error("no key");
      await deps.call(config.endpoint, zadaKey, "zada_report", {
        intent_id: entry.intentId,
        ...(outcome ? { outcome } : {}),
        summary: `${event.toolName.slice(0, 120)} ${outcome === "done" ? "ran" : outcome === "failed" ? "failed" : "finished; the outcome was not reported"}`,
      });
    } catch {
      log("warn", `zada: could not report the outcome of ${event.toolName}`);
    }
  }

  return { before, after, pendingReports: () => open.size };
}

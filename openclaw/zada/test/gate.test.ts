import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, parseConfig, MESSAGES, DEFAULT_ENDPOINT, type GateDeps } from "../src/gate.ts";
import { toolData } from "../src/zada-client.ts";

type Call = { tool: string; args: Record<string, unknown>; key: string; endpoint: string };

function setup(opts: {
  config?: unknown;
  keys?: Record<string, string | null>;
  answers?: Array<Record<string, unknown> | Error>;
  keyError?: boolean;
} = {}) {
  const calls: Call[] = [];
  const answers = [...(opts.answers ?? [])];
  let clock = 1_000_000;
  const deps: GateDeps = {
    key: async (agentId) => {
      if (opts.keyError) throw new Error("unreadable");
      return (opts.keys ?? { sindri: "zna_test" })[agentId] ?? null;
    },
    call: async (endpoint, key, tool, args) => {
      calls.push({ tool, args, key, endpoint });
      clock += 20_000; // each ZADA call takes 20 s of pretend time
      const next = answers.shift();
      if (!next) throw new Error("no answer scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  const linked = { agents: { sindri: { keyEnv: "K" }, mimir: { keyEnv: "K" } } };
  const gate = createGate(parseConfig({ ...linked, ...(opts.config as object | undefined) }), deps);
  return { gate, calls };
}

const send = { toolName: "outlook__send_mail", params: { to: "someone", subject: "hi" }, toolCallId: "call-1", runId: "run-1" };
const ctx = { agentId: "sindri", trigger: "user" };

test("a lookup never contacts ZADA", async () => {
  const { gate, calls } = setup();
  assert.equal(await gate.before({ toolName: "outlook__list_messages", params: {} }, ctx), undefined);
  assert.equal(calls.length, 0);
});

test("allowed: the tool runs and the outcome is reported once", async () => {
  const { gate, calls } = setup({ answers: [{ decision: "allowed", intent_id: "int_1" }, {}] });
  assert.equal(await gate.before(send, ctx), undefined);
  assert.deepEqual(calls[0].tool, "zada_ask");
  assert.equal(calls[0].args.action, "outlook.send_mail");
  assert.equal(calls[0].key, "zna_test");
  assert.equal(calls[0].endpoint, DEFAULT_ENDPOINT);
  assert.equal(typeof calls[0].args.request_id, "string");
  assert.ok(!JSON.stringify(calls[0].args).includes("hi"), "tool arguments are not sent to ZADA");
  await gate.after({ ...send, result: { ok: true } }, ctx);
  assert.equal(calls[1].tool, "zada_report");
  assert.deepEqual([calls[1].args.intent_id, calls[1].args.outcome], ["int_1", "done"]);
  await gate.after({ ...send, result: { ok: true } }, ctx);
  assert.equal(calls.length, 2, "no second report");
  assert.equal(gate.pendingReports(), 0);
});

test("outcome: an error or an error result is failed; nothing reported is not claimed as done", async () => {
  for (const [event, outcome] of [
    [{ error: "boom" }, "failed"],
    [{ result: { isError: true } }, "failed"],
    [{}, undefined],
  ] as const) {
    const { gate, calls } = setup({ answers: [{ decision: "allowed", intent_id: "i" }, {}] });
    await gate.before(send, ctx);
    await gate.after({ ...send, ...event }, ctx);
    assert.equal(calls[1].args.outcome, outcome);
  }
});

test("refused: blocked with ZADA's message, and nothing is reported", async () => {
  const { gate, calls } = setup({ answers: [{ decision: "refused", message: "Not on weekends." }] });
  assert.deepEqual(await gate.before(send, ctx), { block: true, blockReason: "Not on weekends." });
  await gate.after({ ...send, result: {} }, ctx);
  assert.equal(calls.length, 1);
});

test("no permission yet: blocked with a plain instruction", async () => {
  const { gate } = setup({ answers: [{ decision: "no_mandate" }] });
  assert.equal((await gate.before(send, ctx))?.blockReason, MESSAGES.noPermission);
});

test("an answer ZADA never gives is a block, not a pass", async () => {
  for (const answer of [{}, { decision: "ALLOWED" }, { decision: true }, { decision: "allow" }]) {
    const { gate } = setup({ answers: [answer as Record<string, unknown>] });
    assert.equal((await gate.before(send, ctx))?.block, true);
  }
});

test("pending, person present: waits, then runs when approved", async () => {
  const { gate, calls } = setup({ answers: [
    { decision: "pending_approval", intent_id: "int_2" }, { decision: "pending_approval" }, { decision: "allowed" }, {},
  ] });
  assert.equal(await gate.before(send, ctx), undefined);
  assert.deepEqual(calls.map((c) => c.tool), ["zada_ask", "zada_wait", "zada_wait"]);
  assert.equal(calls[1].args.intent_id, "int_2");
  await gate.after({ ...send, result: 1 }, ctx);
  assert.equal(calls[3].args.intent_id, "int_2");
});

test("pending, person present: refused while waiting is a block", async () => {
  const { gate } = setup({ answers: [{ decision: "pending_approval", intent_id: "i" }, { decision: "refused" }] });
  assert.equal((await gate.before(send, ctx))?.blockReason, MESSAGES.refused);
});

test("pending: gives up after waitSeconds and says how to continue", async () => {
  const pending = { decision: "pending_approval", intent_id: "int_3" };
  const { gate, calls } = setup({ config: { waitSeconds: 60 }, answers: [pending, pending, pending, pending, pending, pending] });
  const res = await gate.before(send, ctx);
  assert.ok(res?.blockReason.startsWith(MESSAGES.pending));
  assert.ok(res?.blockReason.includes("int_3"));
  assert.ok(calls.length <= 4, `stopped waiting (made ${calls.length} calls)`);
});

test("pending in a scheduled run, or with waiting off: no waiting at all", async () => {
  for (const [config, trigger] of [[{}, "cron"], [{}, "heartbeat"], [{ waitSeconds: 0 }, "user"]] as const) {
    const { gate, calls } = setup({ config, answers: [{ decision: "pending_approval", intent_id: "i" }] });
    const res = await gate.before(send, { agentId: "sindri", trigger });
    assert.ok(res?.blockReason.startsWith(MESSAGES.pending));
    assert.equal(calls.length, 1);
  }
});

test("ZADA unreachable or key unreadable: blocked", async () => {
  const a = setup({ answers: [new Error("network")] });
  assert.equal((await a.gate.before(send, ctx))?.blockReason, MESSAGES.unreachable);
  const b = setup({ keyError: true });
  assert.equal((await b.gate.before(send, ctx))?.blockReason, MESSAGES.unreachable);
  const c = setup({ answers: [{ decision: "pending_approval", intent_id: "i" }, new Error("network")] });
  assert.equal((await c.gate.before(send, ctx))?.blockReason, MESSAGES.unreachable);
});

test("agent without a key: passes unless required", async () => {
  const open = setup({ keys: {} });
  assert.equal(await open.gate.before(send, ctx), undefined);
  assert.equal(open.calls.length, 0);
  const strict = setup({ keys: {}, config: { required: true } });
  assert.equal((await strict.gate.before(send, ctx))?.blockReason, MESSAGES.unlinked);
  assert.equal(await strict.gate.before({ toolName: "read", params: {} }, ctx), undefined, "reading still works");
});

test("not required: an agent that is not in the settings is left alone, even when ZADA is down", async () => {
  const { gate, calls } = setup({ config: { agents: { sindri: { keyEnv: "A" } } }, answers: [new Error("down")] });
  assert.equal(await gate.before(send, { agentId: "frigg" }), undefined);
  assert.equal(calls.length, 0);
  assert.equal((await gate.before(send, ctx))?.blockReason, MESSAGES.unreachable);
});

test("no agent id: an action is blocked, a lookup still passes", async () => {
  const { gate, calls } = setup();
  assert.equal((await gate.before(send, {}))?.blockReason, MESSAGES.noAgent);
  assert.equal(await gate.before({ toolName: "read", params: {} }, {}), undefined);
  assert.equal(calls.length, 0);
});

test("each agent asks with its own key", async () => {
  const { gate, calls } = setup({ config: { agents: { sindri: { keyEnv: "A" }, mimir: { keyEnv: "B" } } }, keys: { sindri: "zna_s", mimir: "zna_m" }, answers: [{ decision: "allowed", intent_id: "a" }, { decision: "allowed", intent_id: "b" }] });
  await gate.before(send, { agentId: "sindri" });
  await gate.before(send, { agentId: "mimir" });
  assert.deepEqual(calls.map((c) => c.key), ["zna_s", "zna_m"]);
  assert.notEqual(calls[0].args.request_id, calls[1].args.request_id);
});

test("without a tool call id the outcome is still matched to its ask", async () => {
  const { gate, calls } = setup({ answers: [{ decision: "allowed", intent_id: "int_9" }, {}] });
  const event = { toolName: "outlook__send_mail", params: { a: 1 }, runId: "r" };
  await gate.before(event, ctx);
  await gate.after({ ...event, result: 1 }, ctx);
  assert.equal(calls[1].args.intent_id, "int_9");
});

test("a failed report does not throw into the agent run", async () => {
  const { gate } = setup({ answers: [{ decision: "allowed", intent_id: "i" }, new Error("down")] });
  await gate.before(send, ctx);
  await gate.after({ ...send, result: 1 }, ctx);
});

test("settings: wrong values fall back to the stricter default", () => {
  const cfg = parseConfig({ endpoint: "http://evil.example", required: "yes", waitSeconds: 99999, shell: { default: "anything", rules: [{ match: 1 }, { match: "a", action: "b.c" }] }, skip: ["x", 3, ""], agents: { a: {}, b: { keyFile: "/k" }, c: { keyEnv: "K" } } });
  assert.equal(cfg.endpoint, DEFAULT_ENDPOINT);
  assert.equal(cfg.required, false);
  assert.equal(cfg.waitSeconds, 540);
  assert.equal(cfg.policy.shell.default, "ask");
  assert.deepEqual(cfg.policy.shell.rules, [{ match: "a", action: "b.c" }]);
  assert.deepEqual(cfg.policy.skip, ["x"]);
  assert.deepEqual(Object.keys(cfg.agents), ["b", "c"]);
  assert.equal(parseConfig(undefined).waitSeconds, 60);
  assert.equal(parseConfig({ waitSeconds: -5 }).waitSeconds, 0);
});

test("ZADA tool errors are errors, not empty answers", () => {
  assert.throws(() => toolData({ isError: true, content: [{ type: "text", text: "{}" }] }));
  assert.deepEqual(toolData({ structuredContent: { decision: "allowed" } }), { decision: "allowed" });
  assert.deepEqual(toolData({ content: [{ type: "text", text: '{"decision":"refused"}' }] }), { decision: "refused" });
});

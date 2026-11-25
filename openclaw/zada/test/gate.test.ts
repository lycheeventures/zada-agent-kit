import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, parseConfig, MESSAGES, MAX_REFUSAL_CHARS, DEFAULT_ENDPOINT, type GateDeps } from "../src/gate.ts";
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
      return (opts.keys ?? { scout: "zna_test" })[agentId] ?? null;
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
  const linked = { agents: { scout: { keyEnv: "K" }, atlas: { keyEnv: "K" } } };
  const gate = createGate(parseConfig({ ...linked, ...(opts.config as object | undefined) }), deps);
  return { gate, calls };
}

const send = { toolName: "outlook__send_mail", params: { to: "someone", subject: "hi" }, toolCallId: "call-1", runId: "run-1" };
const ctx = { agentId: "scout", trigger: "user" };

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

test("refused for the action name: the names ZADA lists and its closing instruction reach the agent whole", async () => {
  const names = Array.from({ length: 20 }, (_, i) => `wordpress.publish.site_number_${i}`).join(", ");
  const message = `The holder's permission has no line named "post.publish". The refusal is on the record. It names these actions: ${names}. If what you are about to do is truly one of them, ask again under that exact name and describe it honestly; a name ending in * stands for any one word there. Never pick a name just to get through. If it is none of them, do not do it: call zada_request_mandate to ask the holder for it, or tell the holder.`;
  assert.ok(message.length > 400 && message.length < MAX_REFUSAL_CHARS);
  const { gate } = setup({ answers: [{ decision: "refused", reason: "action_not_allowed", message }] });
  assert.equal((await gate.before(send, ctx))?.blockReason, message);
});

test("refused with an overlong message: cut at the limit, never passed on whole", async () => {
  const { gate } = setup({ answers: [{ decision: "refused", message: "x".repeat(MAX_REFUSAL_CHARS + 500) }] });
  assert.equal((await gate.before(send, ctx))?.blockReason?.length, MAX_REFUSAL_CHARS);
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
    const res = await gate.before(send, { agentId: "scout", trigger });
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
  const { gate, calls } = setup({ config: { agents: { scout: { keyEnv: "A" } } }, answers: [new Error("down")] });
  assert.equal(await gate.before(send, { agentId: "other" }), undefined);
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
  const { gate, calls } = setup({ config: { agents: { scout: { keyEnv: "A" }, atlas: { keyEnv: "B" } } }, keys: { scout: "zna_s", atlas: "zna_m" }, answers: [{ decision: "allowed", intent_id: "a" }, { decision: "allowed", intent_id: "b" }] });
  await gate.before(send, { agentId: "scout" });
  await gate.before(send, { agentId: "atlas" });
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

test("a new call gets a new id, so the same action can be done again", async () => {
  const { gate, calls } = setup({ answers: [{ decision: "allowed", intent_id: "a" }, {}, { decision: "allowed", intent_id: "b" }] });
  await gate.before(send, ctx);
  await gate.after({ ...send, result: 1 }, ctx);
  await gate.before({ ...send, toolCallId: "call-2" }, ctx);
  const ids = calls.filter((c) => c.tool === "zada_ask").map((c) => c.args.request_id as string);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(id, /^[0-9a-f]{40}$/);
});

test("a call still waiting for approval is asked again under the same id, then a later one gets a new id", async () => {
  const pending = { decision: "pending_approval", intent_id: "p" };
  const { gate, calls } = setup({ config: { waitSeconds: 0 }, answers: [pending, pending, { decision: "allowed", intent_id: "p" }, {}, { decision: "allowed", intent_id: "q" }] });
  await gate.before(send, ctx);
  await gate.before(send, ctx);
  assert.equal(await gate.before(send, ctx), undefined);
  await gate.after({ ...send, result: 1 }, ctx);
  await gate.before(send, ctx);
  const ids = calls.filter((c) => c.tool === "zada_ask").map((c) => c.args.request_id);
  assert.deepEqual([ids[0] === ids[1], ids[1] === ids[2], ids[2] === ids[3]], [true, true, false]);
});

test("a refused call is not resumed: the next identical call is a new ask", async () => {
  const { gate, calls } = setup({ config: { waitSeconds: 0 }, answers: [{ decision: "pending_approval", intent_id: "p" }, { decision: "refused" }, { decision: "allowed", intent_id: "n" }] });
  await gate.before(send, ctx);
  await gate.before(send, ctx);
  await gate.before(send, ctx);
  const ids = calls.map((c) => c.args.request_id);
  assert.deepEqual([ids[0] === ids[1], ids[1] === ids[2]], [true, false]);
});

test("a waiting entry older than a day is replaced by the new ask, which is then picked up", async () => {
  const pending = { decision: "pending_approval", intent_id: "p" };
  let clock = 0;
  const calls: string[] = [];
  const answers: Array<Record<string, unknown>> = [pending, pending, pending, { decision: "allowed", intent_id: "p2" }];
  const gate = createGate(parseConfig({ waitSeconds: 0, agents: { scout: { keyEnv: "K" } } }), {
    key: async () => "zna_test",
    call: async (_e, _k, _tool, args) => { calls.push(args.request_id as string); return answers.shift()!; },
    now: () => clock,
  });
  await gate.before(send, ctx);
  clock = 24 * 60 * 60 * 1000;
  await gate.before(send, ctx);
  await gate.before(send, ctx);
  assert.equal(await gate.before(send, ctx), undefined);
  assert.deepEqual([calls[0] === calls[1], calls[1] === calls[2], calls[2] === calls[3]], [false, true, true]);
});

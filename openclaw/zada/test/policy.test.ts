import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, requestId, commandLabel, splitCommand, ACTION_RE, ACTION_MAX, DEFAULT_POLICY, type Policy } from "../src/policy.ts";

const P = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });
const ask = (tool: string, params: unknown = {}, policy = DEFAULT_POLICY) => {
  const v = classify("sindri", tool, params, policy);
  assert.equal(v.kind, "ask", `${tool} should be asked`);
  return v as Extract<typeof v, { kind: "ask" }>;
};
const pass = (tool: string, params: unknown = {}, policy = DEFAULT_POLICY) => {
  const v = classify("sindri", tool, params, policy);
  assert.equal(v.kind, "pass", `${tool} should pass`);
  return v as Extract<typeof v, { kind: "pass" }>;
};

test("local tools pass without asking", () => {
  for (const tool of ["read", "write", "edit", "apply_patch", "memory_search", "web_search", "web_fetch", "session_status"]) pass(tool);
});

test("MCP tools: lookups pass, everything else is asked under server.tool", () => {
  assert.equal(pass("outlook__list_messages").why, "read");
  assert.equal(pass("crm__get_person").why, "read");
  assert.equal(ask("outlook__send_mail").action, "outlook.send_mail");
  assert.equal(ask("claw-connect-eir__basecamp_create_todo").action, "claw_connect_eir.basecamp_create_todo");
  assert.equal(ask("9lives__Delete-Everything!").action, "tool_9lives.delete_everything");
});

test("a lookup-looking name is not trusted when the word only starts the same", () => {
  ask("shop__getaway_book");
  ask("mail__listen_and_forward");
});

test("built-in tools that act are asked, with the sub-action in the name", () => {
  assert.equal(ask("message", { action: "send", channel: "telegram" }).action, "message.send");
  assert.match(ask("message", { action: "send", channel: "telegram" }).description, /on telegram/);
  assert.equal(ask("cron", { action: "add" }).action, "cron.add");
  assert.equal(ask("browser").action, "browser.call");
  assert.equal(pass("cron", { action: "list" }).why, "read");
  assert.equal(pass("message", { action: "read" }).why, "read");
});

test("an unknown tool is asked, never waved through", () => {
  assert.equal(ask("brand_new_tool").action, "brand_new_tool.call");
  assert.equal(ask("gateway", { action: "restart" }).action, "gateway.restart");
});

test("shell: asked as shell.run by default; rules name the action; most dangerous part decides", () => {
  assert.equal(ask("exec", { command: "ls -la" }).action, "shell.run");
  const policy = P({ shell: { default: "pass", rules: [
    { match: "wp_multisite\\.py\\s+(post|update|write-|scan-)", action: "wordpress.publish" },
    { match: "^git\\s+push", action: "repo.push" },
  ] } });
  assert.equal(pass("exec", { command: "ls -la" }, policy).why, "shell_pass");
  assert.equal(ask("exec", { command: "cd /tmp && git push origin main" }, policy).action, "repo.push");
  assert.equal(ask("bash", { command: "python3 /x/wp_multisite.py post --site drive" }, policy).action, "wordpress.publish");
  // order of rules, not order in the command, decides
  assert.equal(ask("exec", { command: "git push; python3 wp_multisite.py post" }, policy).action, "wordpress.publish");
});

test("shell: no readable command is asked even when the default is pass", () => {
  const policy = P({ shell: { default: "pass", rules: [] } });
  assert.equal(ask("exec", {}, policy).action, "shell.run");
  assert.equal(ask("code_execution", { code: "fetch('https://x')" }, policy).action, "shell.run");
});

test("shell: a broken or badly named rule never widens access", () => {
  const policy = P({ shell: { default: "ask", rules: [{ match: "(", action: "x.y" }, { match: "ls", action: "NOT VALID" }] } });
  assert.equal(ask("exec", { command: "ls" }, policy).action, "shell.run");
});

test("shell description names the program and script, never the arguments", () => {
  assert.equal(commandLabel("TOKEN=abc python3 /root/skills/mail.py send --to a@b.c --body secret"), "python3 mail.py");
  assert.equal(commandLabel("curl -H 'Authorization: Bearer sk-123' https://x"), "curl");
  const d = ask("exec", { command: "python3 mail.py send --body 'my secret'" }).description;
  assert.ok(!d.includes("secret") && d.includes("mail.py"));
  assert.deepEqual(splitCommand("a && b ; c | d\ne"), ["a", "b", "c", "d", "e"]);
});

test("skip, read and ask lists", () => {
  const policy = P({ skip: ["claw-connect*__*"], read: ["weather__*"], ask: ["web_fetch", "crm__get_person"] });
  assert.equal(pass("claw-connect-eir__basecamp_create_todo", {}, policy).why, "skipped");
  assert.equal(pass("weather__set_alarm", {}, policy).why, "read");
  assert.equal(ask("web_fetch", {}, policy).action, "web_fetch.call");
  assert.equal(ask("crm__get_person", {}, policy).action, "crm.get_person");
  ask("outlook__send_mail", {}, policy);
});

test("every action name is one ZADA accepts", () => {
  const long = "x".repeat(200);
  for (const [tool, params] of [["outlook__send_mail", {}], [`${long}__${long}`, {}], ["message", { action: long }], ["Ünïcode__Tööl", {}], ["__", {}], ["a__", {}], ["exec", { command: "x" }]] as const) {
    const v = classify("a", tool, params);
    if (v.kind === "ask") {
      assert.match(v.action, ACTION_RE, v.action);
      assert.ok(v.action.length <= ACTION_MAX, v.action);
      assert.ok(v.description.length <= 300);
    }
  }
});

test("request id: same call same id, any difference a new id, key order ignored", () => {
  const a = requestId("sindri", "t", { a: 1, b: { c: 2, d: 3 } });
  assert.equal(a, requestId("sindri", "t", { b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(a, requestId("mimir", "t", { a: 1, b: { c: 2, d: 3 } }));
  assert.notEqual(a, requestId("sindri", "t", { a: 2, b: { c: 2, d: 3 } }));
  assert.equal(a.length, 40);
  assert.notEqual(requestId("s", "t", {}, "2026-11-24"), requestId("s", "t", {}, "2026-11-25"));
});

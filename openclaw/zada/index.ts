// ZADA for OpenClaw: every tool call an agent makes is checked with ZADA before it runs.
import { readFile } from "node:fs/promises";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGate, parseConfig, type GateConfig } from "./src/gate.ts";
import { callZada } from "./src/zada-client.ts";

const KEY_TTL_MS = 60_000;

/** Reads each agent's key from its file or environment variable. The key is never logged. */
function keyReader(config: GateConfig) {
  const cache = new Map<string, { at: number; value: string | null }>();
  return async (agentId: string): Promise<string | null> => {
    const hit = cache.get(agentId);
    if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.value;
    const link = Object.prototype.hasOwnProperty.call(config.agents, agentId) ? config.agents[agentId] : undefined;
    let value: string | null = null;
    if (link?.keyFile) value = (await readFile(link.keyFile, "utf8")).trim() || null;
    else if (link?.keyEnv) value = process.env[link.keyEnv]?.trim() || null;
    // A configured agent whose key cannot be read is an error (blocked), not "not connected".
    if (link && !value) throw new Error("ZADA key is configured but empty");
    cache.set(agentId, { at: Date.now(), value });
    return value;
  };
}

export default definePluginEntry({
  id: "zada",
  name: "ZADA",
  description: "Checks each agent action with ZADA before it runs and records what happened.",
  register(api) {
    const config = parseConfig(api.pluginConfig);
    const gate = createGate(config, {
      key: keyReader(config),
      call: callZada,
      log: (level, message) => api.logger[level](message),
    });
    // The wait for a person's approval happens inside the hook, so it needs more than the default 15 seconds.
    api.on("before_tool_call", (event, ctx) => gate.before(event, ctx), { timeoutMs: (config.waitSeconds + 50) * 1000 });
    api.on("after_tool_call", (event, ctx) => gate.after(event, ctx));
    api.logger.info(`zada: ${Object.keys(config.agents).length} agent(s) connected; required=${config.required}`);
  },
});

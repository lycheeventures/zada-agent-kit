// Calls one ZADA tool over MCP (JSON-RPC over HTTPS) with the agent's own key.

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The tool's answer as an object. Throws on any transport, protocol or tool error. */
export async function callZada(
  endpoint: string,
  key: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(40_000);
  const res = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) throw new Error(`ZADA returned HTTP ${res.status}`);
  const text = await res.text();
  const frames = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter((line) => line !== "[DONE]")
    : [text];
  for (const frame of frames.reverse()) {
    const body = record(JSON.parse(frame));
    if (body["error"]) throw new Error("ZADA returned a protocol error");
    if ("result" in body) return toolData(body["result"]);
  }
  throw new Error("ZADA returned an unreadable response");
}

export function toolData(result: unknown): Record<string, unknown> {
  const body = record(result);
  if (body["isError"] === true) throw new Error("ZADA returned a tool error");
  if (body["structuredContent"]) return record(body["structuredContent"]);
  const content = body["content"];
  const first = Array.isArray(content) ? content.find((item) => record(item)["type"] === "text") : undefined;
  const text = record(first)["text"];
  return typeof text === "string" ? record(JSON.parse(text)) : {};
}

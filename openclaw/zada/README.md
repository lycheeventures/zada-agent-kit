# ZADA for OpenClaw

A plugin that makes every OpenClaw agent ask ZADA before it acts, and tell ZADA what happened after.

The person or company the agent works for sets the permissions in ZADA Work or ZADA Home. This plugin
is what enforces them inside OpenClaw, for every tool the agent can reach: tools from any MCP server,
messages, scheduled jobs it creates, and shell commands.

> Status: tested offline (36 tests) and in a live OpenClaw 2026.11.6 gateway with a real ZADA key:
> allowed, reported, waiting for approval, approved, declined, no permission, and ZADA unreachable.
> Not yet tested together with the sandbox.

## What happens on each tool call

| The agent wants to | What the plugin does |
|---|---|
| Look something up (read a file, search, list, get) | Lets it through. ZADA is not contacted. |
| Do something (send, create, post, change, run a command) | Asks ZADA first, with the agent's own key. |
| ZADA says **allowed** | The tool runs. Afterwards the plugin reports `done` or `failed`. |
| ZADA says **waiting for approval** | In a conversation with a person, the plugin waits (60 seconds by default) and carries on if they approve. Otherwise the agent is told nothing was done and to try the same call again later. |
| ZADA says **refused**, or the agent has no permission yet | The tool does not run. The agent is told why. |
| ZADA cannot be reached | The tool does not run. |

What is sent to ZADA: the agent's id, the tool's name, a short action name such as
`outlook.send_mail`, and one sentence such as "scout wants to use send_mail on outlook". Tool
arguments are **not** sent: no message text, no recipients, no command arguments.

A new call always gets its own request, so an agent can do the same thing again later. Only a call
whose approval is still open picks that approval up when it is tried again. Open approvals are kept in
memory: after a gateway restart, a waiting call asks the person again.

## Two limits you should know

1. **Turn on OpenClaw's sandbox for the agents you connect.** The plugin runs inside the gateway. An
   agent that can run shell commands on the host with network access can reach the same services
   directly, or change the gateway's own files. With the sandbox on and its network off, a shell
   command can only work on local files, and everything that reaches the outside world goes through a
   tool this plugin checks. Without the sandbox, the plugin records and limits what agents do through
   their tools, and no more.
2. **Scheduled `command` jobs are not covered.** They are scripts the operator wrote, run by the
   gateway itself, not tool calls an agent chose. Scheduled agent turns are covered.

## Install

```bash
openclaw plugins install --link ./openclaw/zada
```

For each agent, add it in ZADA Work (a company's agent) or ZADA Home (your own agent). You get a key
that starts with `zna_`. Save it in a file only the gateway's user can read, one file per agent:

```bash
install -m 600 /dev/null ~/.openclaw/zada-keys/scout.key   # then paste the key into it
```

Then point the plugin at the files, in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      zada: {
        enabled: true,
        config: {
          agents: {
            scout: { keyFile: "/home/openclaw/.openclaw/zada-keys/scout.key" },
            atlas: { keyFile: "/home/openclaw/.openclaw/zada-keys/atlas.key" },
          },
        },
      },
    },
  },
}
```

Keep the key files outside every agent's workspace.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `agents` | none | OpenClaw agent id → `keyFile` or `keyEnv` (the name of an environment variable). |
| `required` | `false` | `false`: an agent with no key works as before, unchecked. `true`: an agent with no key can still read, but cannot do anything that needs asking. Switch it on once every agent is connected. |
| `waitSeconds` | `60` | How long to wait for an approval when a person started the run. `0` never waits. Scheduled runs never wait. Maximum 540. |
| `skip` | none | Tool-name patterns that are already checked elsewhere, for example a gateway that asks ZADA itself: `["my-gateway__*"]`. Without this the person may be asked twice. |
| `read` | none | Extra tool-name patterns that only look things up. |
| `ask` | none | Tool-name patterns that are always asked, for example `["web_fetch"]`. |
| `shell.default` | `"ask"` | What happens to a shell command no rule names. `"ask"` asks under the action `shell.run`. `"pass"` lets it run and is only safe inside a sandbox with no network. |
| `shell.rules` | none | Names specific commands, most dangerous first: `{ "match": "^git\\s+push", "action": "repo.push" }`. `match` is a regular expression tested against each part of a compound command. |
| `endpoint` | `https://mcp.zada.io/mcp` | Where ZADA is asked. Must be `https`. |

## How actions are named

The person sees these names when they give a permission in ZADA.

| Tool call | Action |
|---|---|
| MCP tool `outlook__send_mail` | `outlook.send_mail` |
| Built-in tool with a sub-action: `message` with `action: "send"` | `message.send` |
| Built-in tool without one: `browser` | `browser.call` |
| Shell command matched by a rule | The rule's action |
| Any other shell command, or code execution | `shell.run` |

Lookups pass without asking: OpenClaw's file, memory, session, media and web-search tools, and any MCP
tool or sub-action whose first word (or second, after a service name) is `list`, `get`, `fetch`, `search`, `find`, `read`, `count`,
`lookup`, `describe`, `view`, `show` or `whoami`. A tool the plugin does not know is asked.

`web_fetch` passes by default because it reads. It can also carry data out in a web address; add it
to `ask` if that matters for your agents.

## Test

```bash
node --test test/*.test.ts
```

Needs Node 24 or newer. No dependencies.

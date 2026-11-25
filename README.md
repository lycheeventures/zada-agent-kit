# ZADA agent kit

Tools that help developers and their coding agents integrate with [ZADA](https://zada.network).

## Log in with ZADA

Add "Log in with ZADA" to a website or app: standard OpenID Connect, where the user proves who they
are with a credential in the ZADA Wallet instead of a password.

- **Guide:** [docs/zada-login.md](docs/zada-login.md) — also published at
  <https://portal.zada.solutions/zada-login.md>
- **Claude Code plugin:** rules, a reference implementation (Node.js / Express / Postgres) and a
  smoke test.

```
/plugin marketplace add lycheeventures/zada-agent-kit
/plugin install zada-login@zada
```

Then ask Claude Code to "add Log in with ZADA". It will ask you for your `client_id` and callback
URLs, implement the flow, and run the smoke test.

- **Other agents (Cursor, Codex, …):** see [AGENTS.md](AGENTS.md).
- **Smoke test on its own:**

```bash
bash plugins/zada-login/skills/zada-login/scripts/verify.sh <client_id> <registered_callback_url>
```

You need a `client_id` from ZADA first. Organisations manage their callback URLs and client secret
in the [ZADA Portal](https://portal.zada.solutions) under **OAuth Setup**.

## ZADA for OpenClaw

A plugin that makes every OpenClaw agent ask ZADA before it acts, and tell ZADA what happened after.
The person or company the agent works for sets the permissions in ZADA Work or ZADA Home; the plugin
enforces them for every tool the agent can reach, including tools from any MCP server and shell
commands.

- **Plugin and guide:** [openclaw/zada/](openclaw/zada/README.md)

```bash
openclaw plugins install --link ./openclaw/zada
```

## Contact

ZADA Solutions Pte. Ltd. — through your ZADA contact, or <https://zada.network>.

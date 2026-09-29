# jev-route

A Claude Code plugin that routes each turn to the cheapest capable Claude model.
Before a prompt runs, it asks **Jev**, TypeSafe's decision model, how much model
capability the prompt needs (`fast`, `balanced` or `powerful`) and how risky a
careless answer would be, then rewrites the model (and, optionally, the effort)
for every API request of that turn. Trivial prompts go to Haiku, everyday coding
stays on Sonnet, hard or risky work moves up to Opus, and the whole turn shares one
model so the prompt cache is kept. Toggle it any time with `/route`. Nothing is
installed beside the plugin itself: no shell hooks, no MCP server, no npm
dependencies.

> **Early access.** jev-route is a *hooks module* plugin, an early-access Claude
> Code feature. The plugin API may change between releases; see
> [Early-access caveats](#early-access-caveats).

## Requirements

- **Claude Code 2.1.259 or later** (`claude --version`). Developed and verified
  against 2.1.283 and 2.1.284.
- **The early-access flag** `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in Claude Code's
  environment. Without it the plugin installs but never loads. The `env` block of
  `~/.claude/settings.json` is the easiest place; see [Quick start](#quick-start).
- **A Jev key** from one of two providers. Both speak the same TypeSafe wire
  format; the plugin only changes the base URL.
  - [TypeSafe](https://typesafe.ai) API key (`provider=typesafe`), or
  - [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key (`provider=gateway`).

  Without a key the plugin can still route with Claude Code's built-in classifier
  (`fallback_classifier`), which never leaves the machine but has no risk signal.

## Quick start

```sh
# 1. Register the marketplace (this repository) and install the plugin
claude plugin marketplace add drewpayment/jev-route
claude plugin install jev-route@jev-route

# 2. Turn on hooks modules (early access). Add to the "env" block of
#    ~/.claude/settings.json, keeping any keys already there:
#    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

# 3. Configure the provider and key, either non-interactively at install time...
claude plugin install jev-route@jev-route --config provider=gateway --config jev_api_key=YOUR_KEY
#    ...or inside Claude Code with the configure form (enter the key LAST, then Save):
#    /plugin configure jev-route

# 4. Restart Claude Code, then check
#    /route status
```

`/route status` should show `enabled: yes`, `API key: present (...)`, `source: jev`
and no `last error` line. The first eligible prompt you send sets the status line to
something like `route: fast claude-haiku-4-5 0.97`.

## "Set me up" prompt

Prefer to let Claude do it? Start Claude Code and paste this prompt. It never asks
Claude to print the key back.

````text
Set up the jev-route plugin for me. Follow these steps in order and confirm each
one before moving on.

1. Register the marketplace and install the plugin by running, in a shell:
     claude plugin marketplace add drewpayment/jev-route
     claude plugin install jev-route@jev-route
   If either command reports the marketplace or plugin already exists, that is fine.

2. Enable hooks modules. Read ~/.claude/settings.json (create it as {} if missing).
   Add "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" inside its top-level "env" object,
   creating "env" if it does not exist. Preserve every other key and value in the
   file exactly as they are; do not remove or reorder anything else. Show me the
   resulting "env" block, but mask the values of any key that looks like a secret.

3. Ask me which Jev provider I use: "typesafe" (TypeSafe API key) or "gateway"
   (Vercel AI Gateway key). Then ask me to paste the key. Treat the key as a secret:
   never repeat it, never print it in a summary, never write it to any file, and
   never put it in a commit. Offer me two ways to store it and do the one I pick:
     a) Non-interactive: run
          claude plugin install jev-route@jev-route --config provider=<provider> --config jev_api_key=<key>
        substituting my answers. Do not echo the command back with the key in it.
     b) Interactive: tell me to run /plugin configure jev-route in Claude Code,
        set "Jev provider" to my answer, and enter the "Jev API key" as the LAST
        field before pressing Save (the form sometimes drops a sensitive value
        that is not the last one entered).

4. Tell me to fully restart Claude Code (the flag from step 2 and the newly
   installed plugin only take effect on a fresh start), then to run /route status.

5. Ask me to paste the output of /route status. Verify it shows "enabled: yes",
   "API key: present", "source: jev" and that there is no "last error" line. If the
   key is missing, tell me to re-enter it with /plugin configure jev-route (key
   last) or to put it as JEV_API_KEY in the "env" block of ~/.claude/settings.json.
   If "source" is "builtin", the key was not picked up. If there is a "last error",
   explain it using the Troubleshooting section of
   https://github.com/drewpayment/jev-route#troubleshooting.
````

## Configuration

Claude Code prompts for the options when the plugin is enabled. To change them
later run `/plugin configure jev-route`, or pass `--config KEY=VALUE` to
`claude plugin install`.

| provider   | key                       | base URL (derived)                       |
|------------|---------------------------|------------------------------------------|
| `typesafe` | TypeSafe API key          | `https://api.typesafe.ai`                |
| `gateway`  | Vercel AI Gateway key     | `https://ai-gateway.vercel.sh/typesafe`  |
| `custom`   | whatever your proxy wants | **you must set `jev_base_url`**          |

`jev_api_key` is marked `sensitive`, so Claude Code masks it on input and keeps it
in secure storage rather than `settings.json`. When it is empty the plugin falls
back to the `env` block of your settings, trying `JEV_API_KEY`, then
`AI_GATEWAY_API_KEY`, then `TYPESAFE_API_KEY`. That is plaintext in
`settings.json`, so prefer the configure form when it works. `/route status`
reports which source the key came from and never prints it.

All options:

| key                    | default                     | meaning                                                              |
|------------------------|-----------------------------|----------------------------------------------------------------------|
| `provider`             | `typesafe`                  | `typesafe`, `gateway` or `custom`                                    |
| `jev_api_key`          |                             | API key (sensitive)                                                  |
| `jev_base_url`         | `""`                        | override / custom endpoint; empty derives from `provider`. Must be https (http only for localhost/127.0.0.1); anything else is refused and shown as a config error |
| `jev_model`            | `jev-latest`                | Jev model id sent in the request                                     |
| `model_fast`           | `claude-haiku-4-5` | model for the fast tier                                              |
| `model_balanced`       | `claude-sonnet-5-5`           | model for the balanced tier                                          |
| `model_powerful`       | `claude-opus-5-5`           | model for the powerful tier                                          |
| `upgrade_confidence`   | `0.3`                       | min confidence to move to a more capable tier than the session model |
| `downgrade_confidence` | `0.6`                       | min confidence to move to a cheaper tier                             |
| `timeout_ms`           | `800`                       | hard budget (50..5000) for the whole Jev call: fetch, body and parse; on timeout the session model is kept |
| `route_effort`         | `true`                      | also set effort (fast=low, balanced=medium, powerful=high, risky=max); never sent to haiku |
| `fallback_classifier`  | `true`                      | with no key, use Claude Code's built-in small-model classifier       |
| `log_decisions`        | `false`                     | toast each decision (tier, confidence, risky, latency)               |

The model fields take full model ids or the aliases `haiku` / `sonnet` / `opus`.
Current ids at the time of writing: `claude-haiku-4-5`, `claude-sonnet-5-5`,
`claude-opus-5-5`, `claude-fable-5-1`. The `model_balanced` default is
`claude-sonnet-5-5` (Sonnet 5.5). A model your
policy does not allow is refused by the engine with a warning and the request keeps
its own model.

## `/route` commands

```
/route            toggle routing on/off (persists across sessions)
/route on
/route off        stop new decisions; a turn already running keeps its rewrite
/route status     enabled, provider, base URL (userinfo redacted), key present and
                  its source, model map, thresholds, config error, last decision,
                  last error
/route setup      how to set the options and the env flag
```

## How routing decides

1. **Prompt submitted**: if routing is on and the prompt is eligible (3+ chars), the
   plugin redacts secrets, truncates to 20k chars and asks Jev for a `tier`
   (`fast` / `balanced` / `powerful`, with a confidence) and a `risky` score, under
   one hard deadline (`timeout_ms`). The prompt itself is always passed through
   untouched. Any error or timeout means no decision: the session model runs.
2. **Hysteresis against the session's current tier** (inferred from the model id,
   then by family `haiku` < `sonnet` < `opus` < `fable`): upgrade when
   `confidence >= upgrade_confidence`, downgrade when
   `confidence >= downgrade_confidence`, `risky >= 0.7` always goes to `powerful`
   with effort `max`, otherwise stay.
3. **Every request of the turn** gets the same model and effort, so the turn shares
   one prompt cache. Same tier as the session: the session model is kept exactly and
   only effort is rewritten. Unknown session model or any `fable` session: the model
   is never changed. A `[1m]` session carries `[1m]` onto the target. Subagent turns
   are never rewritten.
4. **Turn complete**: the decision becomes `last`, shown by `/route status` and sent
   to Jev as `previous_tier` so "yes", "continue", "now fix the tests" stay on the
   tier that did the work.

Fallback: with no key and `fallback_classifier` on, Claude Code's built-in
classifier picks the tier from the same redacted text (confidence 1.0, no risk
signal); `/route status` shows `source: builtin`.

## Status line

`route: <tier> <model> <confidence>[ (kept)]`, for example
`route: fast claude-haiku-4-5 0.97`, or
`route: balanced claude-sonnet-5-5 0.41 (kept)` when the session model was kept
(effort may still have been routed). It is set when the decision settles on the
first request of the turn. `route: on` means routing is enabled but there is no
decision for this turn (Jev failed, timed out, or the prompt was not graded).
`route: off` when disabled.

## Troubleshooting

**The key does not stick.** The configure form does not reliably persist a
sensitive value unless it is the last field entered before Save. Re-open
`/plugin configure jev-route`, enter the key last, Save. If it still does not
stick, put it in the `env` block of `~/.claude/settings.json` as `JEV_API_KEY`
(or `AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY`) and restart. `/route status` names
the source it used (`from userConfig` or `from settings env JEV_API_KEY`).

**Status line says `route: on` but never shows a decision.** Routing is enabled
but Jev returned nothing. Run `/route status` and read `last error`:
`jev: unauthorized (bad API key)` means the key is wrong or for the other
provider, `jev: rate limited` / `jev: overloaded` are transient, `timeout after
800ms` means raise `timeout_ms` or check the network, `jev: unparseable response`
usually means `jev_base_url` points at something that is not a Jev endpoint, and
`no timer available` means the engine exposed no clock (report it).

**`turn.step: model X is not allowed by policy`.** Your organisation's model
policy refuses that id; the request keeps its own model. Set `model_fast` /
`model_balanced` / `model_powerful` to ids your policy allows.

**Model id not available.** The defaults are `claude-haiku-4-5`, `claude-sonnet-5-5` and
`claude-opus-5-5`. If your account does not have one of them, set that tier to an id
your `/model` picker lists, or to the alias `haiku` / `sonnet` / `opus`.

**"hooks modules are not turned on for installed plugins in this process".**
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is not in the environment. Add it to the
`env` block of `~/.claude/settings.json` (or export it in your shell) and fully
restart Claude Code.

**Configured it once, but a session started with `--plugin-dir` (or the installed
copy) ignores it.** A session-loaded plugin has the id `jev-route@inline`; the
marketplace install is `jev-route@jev-route`. Claude Code stores `pluginConfigs`
and the secure-storage key per id, so each needs its own configuration. Configure
whichever one you actually run, or use the settings `env` fallback, which both
read.

**`/route status` shows `config error`.** `jev_base_url` was refused: it must be
`https://` (plain `http://` only for `localhost` / `127.0.0.1`), no trailing slash
needed.

## Privacy

When routing is on, the **text of each eligible prompt** (secrets redacted, up to
20k chars) is sent to the provider you configured (TypeSafe directly, Vercel AI
Gateway, or your custom endpoint) to be graded. Nothing else from the session is
sent: no files, no tool output, no previous messages, only the prompt and the
previous turn's tier label. Anything that looks like a credential is replaced with
`[REDACTED]` first: `sk-…`, `AKIA…`, `ghp_…`, `AIza…`, `sk_live_…`, PEM private
keys, JWTs, `user:pass@` in URLs, `password|secret|token|api_key = value`
assignments and `Bearer <token>`. Run `/route off` or unset the key to stop sending
prompts; the built-in fallback keeps everything inside Claude Code.

## Updating

```sh
claude plugin marketplace update jev-route
claude plugin update jev-route@jev-route
```

Then restart Claude Code. A new copy is only fetched when the plugin's `version`
changes; see [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
git clone https://github.com/drewpayment/jev-route ~/dev/jev-route
cd ~/dev/jev-route
bun test tests                                          # pure modules + register.ts under a mocked 'claude-code'
claude plugin validate . --strict                       # marketplace + the plugin.json it points at
claude plugin validate .claude-plugin/plugin.json --strict   # plugin manifest + static scan of the hooks module
claude --plugin-dir .                                   # load the checkout in place (id jev-route@inline)
```

Inside a session started with `--plugin-dir`, `/plugin-types` writes the engine's
full `.d.ts` so `tsc --noEmit` typechecks `hooks/register.ts` against the real
`Register` type, and `/reload-plugins` reloads after edits. See
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the rules the engine enforces on
the module, and [docs/DESIGN.md](docs/DESIGN.md) / [docs/ENGINE-API.md](docs/ENGINE-API.md)
for how it works.

## Early-access caveats

- Hooks modules are early access and the `claude-code` module API can change. The
  plugin reads a few engine shapes defensively (the `options` argument of
  `register`, the `$.http.fetch` result, `$.store` signatures).
- Routing adds Jev latency to the first request of each turn (typically 0.4–0.6 s
  through the gateway; capped by `timeout_ms`, max 5 s). The built-in fallback
  runs under the same budget.
- The engine notes that a request resuming a truncated thought keeps its model, so
  a rewrite may take effect one request later.
- `log_decisions` uses toasts, and the engine drops toasts within 2 s of the
  previous one.
- Network access from plugins can be disabled by policy; the plugin then fails open
  and `/route status` shows the last error.

## License

[MIT](LICENSE) © 2026 Drew Payment

# Claude Code hooks-module API (recovered notes)

Ground truth for this build (Claude Code 2.1.283). Recovered from the engine binary's
embedded `plugin-authoring` skill, its example modules, and the compiled event
validators. The API is **early access** (`module 'claude-code'`) and may change
between releases. When `/plugin-types` output is available in `.claude/types/`,
that file wins over these notes.

## Enabling

- Installed plugins' hooks modules load only when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
  is set in Claude Code's environment (engine message: "hooks modules are not turned
  on for installed plugins in this process (early access: set
  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in its environment to load them)").
- `claude plugin validate <dir>` works **without** the flag. It statically reads the
  module and reports `hooks: <events>` and `calls: <$.noun.method list>` and anything
  the engine would refuse. Use it as the compile check.
- `claude plugin test` needs the flag.
- Load for development with `claude --plugin-dir <dir>`; `/reload-plugins` reloads.
- `/plugin-types` (inside a session) writes `.claude/types/claude-code.d.ts`
  (~14k lines, the whole API) plus per-plugin contracts. Point tsconfig at it:
  `"include": [".claude/types", "hooks"]`, `"lib": ["es2023"]`, `"jsx": "react"`,
  `"jsxFactory": "h"`. Then `import type { Register } from 'claude-code'`.

## Plugin files

```
.claude-plugin/plugin.json   { "name", "version", "description", "author", "userConfig", "types"? }
hooks/hooks.json             { "modules": ["./register.ts"] }   (path relative to hooks.json)
hooks/register.ts            export const register: Register = (on, options) => { ... }
types/index.d.ts             optional $.state contract: declare module 'claude-code' { interface PluginState { '<plugin>': {...} } }
```

Rules the engine enforces on the module:
- A hooks module may import only its own files by relative path and `"claude-code"`.
  No npm packages, no Node builtins. No DOM, no Node globals: `$` is the only door out.
- `$` must always be spelled `$.noun.method(...)` at the call site (the static scan
  lists calls). Do not destructure `$` or alias it.
- `on` is always `on("<event>", hook)` or `on("<event>", matcher, hook)`.
- Hook signature: `($, e, next)`. `e` is a frozen plain value. `next(e)` runs the
  plugins beneath and the engine; `next({ ...e, x })` rewrites what they see.
  Returning without calling `next` answers the event yourself.
- A hook that throws is skipped (one dim transcript line) and the chain continues.
- Top-level `await` is not allowed in files the entry imports.
- Module variables reset on reload; `$.state` (session) and `$.store` (across sessions) persist.

## Events used by this plugin

### `session.start`
`on('session.start', async ($, e, next) => { await $.command.register({...}); return next(e) })`
Fires on load and on every reload.

### `command.run`
Matcher `{ command: '<name>' }`. Event: `{ command, args: string, presentation, origin }`.
Return `{ text: string }` (shown to the user). The engine warns if a command is
registered with no `command.run` hook: `add on("command.run", { command: "<name>" }, ($, e) => ({ text: ... }))`.

### `prompt.submit`
Event: `{ text: string, context?: string[], turnId, origin, wait? }`.
Result: `next({ ...e, text })` to rewrite, or return `{ drop: string }` to drop the prompt.
Slash commands, bash-mode `!` input, and inputs that don't query the model never pass
through `prompt.submit`.
Calling `$.prompt.submit` from inside a `prompt.submit` hook deadlocks; don't.

### `turn.step`
Fires before **every** API request of a turn (index 0, 1, ... one per model call).
Event fields (pinned, cannot be rewritten): `turnId`, `index`, `messageCount`, `agentId`.
Rewritable: `model` (non-empty string) and `effort` (`'low' | 'medium' | 'high' | 'max'`;
a number is internal-only and refused).
Rewrite with `next({ ...e, model: '<id>', effort: 'high' })`.
Engine behaviours:
- A model not allowed by policy is refused with a warning and the request keeps its
  own model (`turn.step: model X is not allowed by policy; the request keeps Y`).
- "a request resuming a truncated thought keeps its model; a model rewrite applies
  from the next request".
- Result of `next(e)`: `{ answer: string, toolUses: [...], stopReason, usage }`.
- Changing the model mid-turn discards the prompt cache. Decide once per turn.

### `agent.spawn` (phase 2)
Event includes `{ model?, prompt, ... }`; identity fields are pinned. A rewrite can set
`model` (`next({ ...e, model })`). Result must have `{ model }`.

### `turn.complete`
Event: `{ text/answer, turnId, agentId, ... }`. Good place to clear per-turn state.

### Confirmed by reviewer
- `turn.step` is a streaming hook: write it as `async function* ($, e, next) { ...; return yield* next(patch) }`.
- `prompt.submit` carries `turnId` only when it is already known; usually the turn is
  created afterwards, and `turn.start` (`{ text, turnId, agentId? }`) is where a
  prompt gets bound to its turn.
- `turn.complete` carries `agentId` (undefined for the main agent), so subagent
  completions can be told apart.
- `$.clock.sleep(ms, { signal })` exists in this build and is the preferred timer.

## `$` interface (nouns used here)

- `$.plugin.name` — this plugin's name.
- `$.command.register({ name, description, argumentHint?, immediate? })` — name is
  letters, digits, `_` or `-` (≤64). Registering twice with the same spec is a no-op;
  another plugin owning the name is refused.
- `$.command.run({ command, args? })` — run a slash command (name without slash).
- `$.http.fetch(url, { method?, headers?, body?, signal? })` — http/https only,
  redirect: manual. Refused when policy disables plugin network access. **Verified
  live (2.1.283): the result is NOT a Response. The body arrives already read as
  `text: string` alongside `status`.** `res.text()` throws "res.text is not a
  function". Header values must be printable ASCII or the call fails with
  "Header 'Authorization' has invalid value".
- Sensitive `userConfig` values: the configure form did not persist the secret for a
  `--plugin-dir` plugin (keychain `pluginSecrets` stayed empty) until re-entered in
  the same save; the plugin falls back to settings `env` via `$.settings.read()`.
- `$.ui.status(text | undefined)` — a status-line entry; `undefined` clears it.
  In headless (`-p`) sessions it is logged instead.
- `$.ui.toast(text)` — a toast; toasts within 2s of the previous are dropped.
- `$.ui.ask(question, options | { options, header })` — question dialog, limited
  option count; resolves to the chosen option, throws if dismissed.
- `$.model.classify(text, labels, { model? })` — built-in classifier: returns one of
  `labels` (≥2 non-empty strings). Runs on a small Claude model. Use as fallback.
- `$.clock.now()` — ms timestamp (async).
- `$.store.get(key)` / `$.store.set(key, value)` — per-plugin JSON store across sessions
  (a JSON object file; keys are strings). Exact signatures: verify in d.ts.
- `$.state` — session-scoped values; typed via `PluginState` contract. The
  `atom/read/update` helpers from `'claude-code'` wrap it:
  `const a = atom({ plugin: '<name>', key: '<key>' } as const, initial)`,
  `await read($, a)`, `await update($, a, prev => next)`.
- `$.config.set({ key, value })` / `$.config.list()` — the `/config` rows (userConfig
  options of enabled plugins appear there as rows on ≥2.1.269; `sensitive` ones don't).
- `$.settings.read({ source }?)` — read settings.

## userConfig (plugin.json)

```json
"userConfig": {
  "jev_api_key": { "type": "string", "title": "Jev API key", "description": "...", "sensitive": true, "required": false },
  "provider":    { "type": "string", "title": "Provider", "description": "typesafe | gateway", "default": "typesafe" }
}
```
- Claude Code prompts the user when the plugin is enabled; `/plugin configure <name>`
  re-prompts; `claude plugin install <p> --config KEY=VALUE` sets at install.
- `sensitive: true` masks input and stores in secure storage, not settings.json.
- Non-sensitive values live in settings `pluginConfigs.<plugin@marketplace>.options`.
- Shell hooks see `CLAUDE_PLUGIN_OPTION_<KEY>`; exec-form fields may use
  `${user_config.KEY}`. For hooks modules, the values are delivered through the
  second parameter of `register(on, options)` — **verify the exact shape in the
  d.ts** (`grep -n "Register" .claude/types/claude-code.d.ts`). Treat every option
  as possibly undefined.
- Unknown keys inside an option object fail validation (strict objects).

## Jev API (both providers speak the same TypeSafe wire format)

Request `POST <base>/v1/systemone`, `Authorization: Bearer <key>`, JSON:
```json
{ "model": "jev-latest",
  "state": { "prompt": "...", "previous_tier": "balanced" },
  "questions": {
    "tier": { "type": "choice", "instructions": "...", "criteria": { "fast": "...", "balanced": "...", "powerful": "..." } },
    "risky": { "type": "noul", "instructions": "..." }
  } }
```
Response (verified live 2026-09-27 against the gateway's TypeSafe-compatible path):
```json
{ "model": "jev-latest",
  "answers": {
    "risky": { "type": "noul", "noul": 0.07 },
    "tier":  { "type": "choice", "choice": "fast", "confidence": 1, "probabilities": { "fast": 1, "balanced": 0, "powerful": 0 } } },
  "usage": { "input_tokens": 376, "output_tokens": 59 } }
```
Providers:
| provider  | base URL                                   | model id     | key                    |
|-----------|--------------------------------------------|--------------|------------------------|
| typesafe  | `https://api.typesafe.ai`                  | `jev-latest` | TypeSafe API key       |
| gateway   | `https://ai-gateway.vercel.sh/typesafe`    | `jev-latest` | Vercel AI Gateway key  |

The gateway also has a native `POST https://ai-gateway.vercel.sh/v1/evaluate` with
model `typesafe-ai/jev` whose response uses `boolean`/`probability` naming instead of
`noul`. Not needed: the `/typesafe` path preserves TypeSafe naming, so one client
serves both providers. Errors: 401 bad key, 422 validation, 429 rate limit, 529 overloaded.
Observed latency 0.4–0.6 s through the gateway from a residential connection.

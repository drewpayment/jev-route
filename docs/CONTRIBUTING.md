# Contributing to jev-route

Contributor docs. For how the plugin behaves see [DESIGN.md](DESIGN.md); for the
engine surface it is built on see [ENGINE-API.md](ENGINE-API.md); for user-facing
docs see the [README](../README.md).

## Layout

The repository is both the marketplace and its single plugin:

```
.claude-plugin/marketplace.json   marketplace: one entry, source "./" (this repo)
.claude-plugin/plugin.json        plugin manifest: metadata + userConfig
hooks/hooks.json                  { "modules": ["./register.ts"] }
hooks/register.ts                 wiring only; the only file that touches `$`
hooks/jev.ts                      buildRequest / parseResponse            (pure)
hooks/decide.ts                   hysteresis, tier inference, patch, status (pure)
hooks/config.ts                   resolveConfig + provider base URLs       (pure)
hooks/eligibility.ts              isEligible / redactSecrets / truncateState (pure)
hooks/types.ts                    shared types
types/index.d.ts                  $.state contract (pending, unbound, last)
tests/*.test.ts                   bun tests; register.test.ts fakes `$` and 'claude-code'
docs/                             DESIGN.md, ENGINE-API.md, this file
.github/workflows/ci.yml          bun test + claude plugin validate
```

Generated, git-ignored: `.claude/types/` and `.claude-plugin/types/` (written by
the engine / `/plugin-types`), `.claude/settings.local.json` (your local key).

## Dev loop

Requirements: [bun](https://bun.sh) 1.x and Claude Code 2.1.259+ with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in its environment (the repo's
`.claude/settings.json` already sets it for sessions started here).

```sh
bun test tests                                              # unit tests (no engine needed)
claude plugin validate . --strict                           # marketplace + plugin.json (via the entry)
claude plugin validate .claude-plugin/plugin.json --strict  # plugin manifest + static scan of hooks
bun run validate                                            # both of the above
claude --plugin-dir .                                       # run the checkout in place
```

Inside the session:

- `/plugin-types` writes the engine's `.d.ts` (`.claude-plugin/types/` on 2.1.284,
  `.claude/types/` on earlier builds). `tsconfig.json` includes `.claude/types`;
  add the other path if your build writes there. Then `tsc --noEmit` typechecks
  `hooks/register.ts` against the real `Register` type.
- `/reload-plugins` reloads after edits. Module-level variables reset on reload;
  `$.state` and `$.store` persist.
- `/route status` and `/route setup` show what the plugin resolved.
- A session-loaded plugin is `jev-route@inline`, a marketplace install is
  `jev-route@drewpayment`; each has its own `pluginConfigs` and secure-storage key.
  The settings `env` fallback (`JEV_API_KEY` in `.claude/settings.local.json`) is
  the easiest way to give the checkout a key.

Validation works without the env flag; it is the compile check. `claude plugin
validate` prints the hooks it found and every `$.noun.method` call it could see.
If a call you added is missing from that list, the engine will refuse it at load.

## Rules the engine enforces (from ENGINE-API.md)

Keep these or the module fails the static scan or is refused at load:

- **`$` spelling.** `$` is only ever written `$.noun.method(...)` at the call site,
  or passed whole to a top-level function declaration of `register.ts` (or to
  `read`/`update` from `'claude-code'`). Never destructure `$`, alias it, or store a
  method reference. `register.ts` is the only file allowed to touch `$`; the other
  modules stay pure so they can be unit-tested.
- **Streaming hooks.** `turn.step` is a streaming hook. Write it as an async
  generator that forwards the chunks from `next()` and returns its result:
  `on('turn.step', async function* ($, e, next) { ...; return yield* next(patch) })`.
  Non-streaming hooks are plain `async ($, e, next) => next(e)` or return a value to
  answer the event yourself.
- **Imports.** A hooks module may import only its own files by relative path and
  `'claude-code'`. No npm packages, no Node builtins, no DOM or Node globals
  (timers and `AbortController` are looked up on `globalThis` defensively).
- **No top-level `await`** in any file the entry imports.
- **`on` shape.** Always `on('<event>', hook)` or `on('<event>', matcher, hook)`.
- **Fail open.** Every hook catches its own errors and calls `next(e)` unchanged;
  a hook that throws is skipped for that event. Routing must never block a prompt.
- **One decision per turn.** Decide on the first `turn.step` and apply the same
  patch to every request of the turn; a mid-turn model change discards the prompt
  cache.
- **Caches are per model and per effort.** Between turns, leave a warm model alone
  unless the thresholds say otherwise, and never send `effort` without a model
  rewrite: a top-level effort change invalidates the messages cache too.
- **Events are frozen.** Rewrite with `next({ ...e, model, effort })`; pinned
  fields (`turnId`, `index`, `agentId`) cannot change.

Add a test in `tests/` for any change to the pure modules, and extend
`register.test.ts` for wiring changes. Do not change routing behaviour without
updating DESIGN.md.

## Release

1. Pick the version. Bump it in all four places and keep them equal:
   - `.claude-plugin/plugin.json` `version`
   - `.claude-plugin/marketplace.json` `plugins[0].version`
   - `package.json` `version`
   - `CHANGELOG.md`: move `[Unreleased]` items under a new `[x.y.z] - YYYY-MM-DD`
     heading and add the compare/tag links at the bottom.
2. `bun test tests && bun run validate`.
3. Commit. `claude plugin tag` refuses a dirty working tree.
4. Create the release tag. The tag name is `jev-route--v<version>`; the command
   checks that `plugin.json` and the marketplace entry agree:

   ```sh
   claude plugin tag . --dry-run      # shows the tag it would create
   claude plugin tag . -m "jev-route %s"
   git push origin main --tags        # or: claude plugin tag . --push
   ```

5. Users pick it up with `claude plugin marketplace update drewpayment` and
   `claude plugin update jev-route@drewpayment`. A new copy is fetched only when the
   `version` string changed, so never push behaviour changes without a bump.

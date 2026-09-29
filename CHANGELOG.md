# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-29

### Changed

- Hysteresis now anchors on the model the previous turn was routed to (when the
  session model is unchanged), not on the session model. Returning from a routed
  model to the session model pays the same confidence threshold as any other move,
  so one strong grade no longer flaps the conversation between two prompt caches.
- Effort is pinned per model instead of set per turn: it is sent only together
  with a model rewrite (fast=low, balanced=medium, powerful=high) and never
  changed on a kept model, because a top-level effort change invalidates the
  messages cache. `risky` still forces the powerful tier but no longer sets
  effort `max`.
- `[1m]` is no longer appended to models without a 1M window (haiku, 200k). On a
  `[1m]` session the fast tier is only used while the context is known to be
  under 150k tokens; otherwise the turn takes the next tier up.
- Status line and `/route status` show `(locked)` when a downgrade was blocked.

### Added

- `switch_lock_tokens` (default 50000): once the last request's context reaches
  it, downgrades are blocked (a cold cache write on a cheaper model costs more
  than the turn saves); upgrades and `risky` still move up. `0` disables it.
- Context size and cache usage are read from each `turn.step` result: `context`
  state (last main-agent request), `usage` on the completed decision, a
  `context` / `last usage` line in `/route status`, and with `log_decisions` a
  toast per completed turn (`ctx 152k, cache read 96% (3 steps)`).

## [0.1.0] - 2026-09-28

### Added

- Hooks-module plugin that asks Jev (TypeSafe's decision model) for a capability
  tier (`fast` / `balanced` / `powerful`) and a risk score on every eligible
  prompt, then rewrites the model and effort of every API request of that turn.
- `/route` command: toggle, `on`, `off`, `status` (resolved config, key source,
  last decision, last error) and `setup`.
- Providers: `typesafe` (api.typesafe.ai), `gateway` (Vercel AI Gateway, TypeSafe
  wire format) and `custom` (any https endpoint; plain http only for loopback).
- Sensitive `jev_api_key` userConfig with a fallback to the settings `env` block
  (`JEV_API_KEY`, then `AI_GATEWAY_API_KEY`, then `TYPESAFE_API_KEY`).
- Hysteresis against the session model (`upgrade_confidence`,
  `downgrade_confidence`, `risky >= 0.7` forces the powerful tier with effort `max`).
- Per-turn binding by turn id and agent id, so queued prompts and subagent turns
  never pick up another turn's decision.
- Secret redaction and head+tail truncation (20k chars) before any prompt text
  leaves the machine; prompts under 3 characters are not graded.
- Built-in classifier fallback (`$.model.classify`) when no key is configured.
- Status line `route: <tier> <model> <confidence>[ (kept)]`.
- Marketplace manifest so the repository installs as `jev-route@drewpayment`.

[Unreleased]: https://github.com/drewpayment/jev-route/compare/jev-route--v0.2.0...HEAD
[0.2.0]: https://github.com/drewpayment/jev-route/compare/jev-route--v0.1.0...jev-route--v0.2.0
[0.1.0]: https://github.com/drewpayment/jev-route/releases/tag/jev-route--v0.1.0

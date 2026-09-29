# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/drewpayment/jev-route/compare/jev-route--v0.1.0...HEAD
[0.1.0]: https://github.com/drewpayment/jev-route/releases/tag/jev-route--v0.1.0

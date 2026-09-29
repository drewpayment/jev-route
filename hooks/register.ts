// jev-route: wiring only. This is the only file that touches `$`.
// Every hook fails open: any error keeps the session model untouched.
//
// Engine rules honoured here: `$` is only ever written `$.noun.method(...)` at
// the call site or passed to a top-level function declaration of this file (or
// to read/update from 'claude-code'); turn.step is a streaming hook and so is
// an async generator that forwards next()'s chunks.
//
// Turn binding: prompt.submit composes a decision before the turn exists and
// parks it in `unbound` (and in `pending[turnId]` when the event already carries
// a turnId). turn.start binds it to its turnId/agentId by prompt text. turn.step
// and turn.complete only ever look at `pending[turnId]` of their own turn and
// agent, so subagent turns and queued prompts never touch a running turn.

import type { Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { checkApiKey, defaultEnabled, hasJev, redactUrl, resolveConfig, routingSource, type Config } from './config.ts'
import { composeDecision, describeSession, resolveDecision, statusText, stepPatch } from './decide.ts'
import { isEligible, redactSecrets, truncateState } from './eligibility.ts'
import { buildRequest, describeStatus, parseResponse } from './jev.ts'
import { TIERS, type Answers, type Decision, type Tier } from './types.ts'

const STORE_ENABLED = 'enabled'
const CLASSIFY_LABELS: readonly Tier[] = ['fast', 'balanced', 'powerful']
const PROMPT_KEY_CHARS = 200

const pendingAtom = atom({ plugin: 'jev-route', key: 'pending' } as const, {} as Record<string, Decision>)
const unboundAtom = atom({ plugin: 'jev-route', key: 'unbound' } as const, null as Decision | null)
const lastAtom = atom({ plugin: 'jev-route', key: 'last' } as const, null as Decision | null)

// Diagnostics for `/route status`; module-level, so they reset on reload.
let lastError: string | null = null

type Unknown = Record<string, unknown>

function asRecord(v: unknown): Unknown {
  return typeof v === 'object' && v !== null ? (v as Unknown) : {}
}

function asId(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function sameAgent(a: string | undefined, b: string | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

function promptKeyOf(text: string): string {
  return text.slice(0, PROMPT_KEY_CHARS)
}

function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v)
}

function now(): number {
  return typeof Date !== 'undefined' ? Date.now() : 0
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

// Host globals (timers, AbortController) are not part of lib es2023 and may be
// absent from the module environment, so they are looked up on globalThis.
type TimerFn = (fn: () => void, ms: number) => unknown
type AbortCtl = { signal: unknown; abort(): void }
const host = globalThis as unknown as {
  setTimeout?: TimerFn
  AbortController?: new () => AbortCtl
}

function newAbortController(): AbortCtl | null {
  return typeof host.AbortController === 'function' ? new host.AbortController() : null
}

/**
 * A promise that resolves after `ms`. Prefers the engine clock, falls back to
 * the host timer, and returns null when neither exists (callers then skip the
 * work rather than run unbounded).
 */
function sleepFor($: any, ms: number, signal: unknown): Promise<void> | null {
  // The static scan only accepts `$.noun.method(...)` literally, so the clock is
  // probed by calling it: a missing noun throws synchronously and we fall back.
  try {
    const p: unknown = $.clock.sleep(ms, { signal })
    if (p && typeof (p as Promise<unknown>).then === 'function') return (p as Promise<unknown>).then(() => undefined)
  } catch {
    // no engine clock in this build
  }
  if (typeof host.setTimeout === 'function') return new Promise<void>((resolve) => host.setTimeout!(resolve, ms))
  return null
}

/**
 * Run `work` under one deadline. On timeout the request controller is aborted
 * and the result is null. Returns undefined when no timer exists at all.
 */
async function withDeadline<T>($: any, ms: number, controller: AbortCtl | null, work: () => Promise<T>): Promise<T | null | undefined> {
  const timerCtl = newAbortController()
  const sleep = sleepFor($, ms, timerCtl?.signal)
  if (!sleep) return undefined
  let finished = false
  const timeout: Promise<never> = sleep.then(() => {
    if (finished) return new Promise<never>(() => {})
    try {
      controller?.abort()
    } catch {
      // ignore
    }
    throw new Error(`timeout after ${ms}ms`)
  })
  try {
    return await Promise.race([work(), timeout])
  } finally {
    finished = true
    try {
      timerCtl?.abort()
    } catch {
      // ignore
    }
  }
}

// ---- API key fallback from settings `env` -------------------------------

/** Env var names tried, in order, when the userConfig key is absent. */
export const KEY_ENV_VARS = ['JEV_API_KEY', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY'] as const

/** Pull an `env` map out of whatever $.settings.read returns (shape unverified). */
function envOfSettings(result: unknown): Unknown {
  const r = asRecord(result)
  for (const candidate of [r.env, asRecord(r.settings).env, asRecord(r.value).env, asRecord(r.merged).env]) {
    if (candidate && typeof candidate === 'object') return candidate as Unknown
  }
  return {}
}

/** The first usable key from settings env, with the variable it came from; null when none. */
async function keyFromSettings($: any): Promise<{ key: string; source: string } | null> {
  let env: Unknown
  try {
    env = envOfSettings(await $.settings.read())
  } catch {
    return null
  }
  for (const name of KEY_ENV_VARS) {
    const checked = checkApiKey(env[name])
    if (checked.apiKey) return { key: checked.apiKey, source: name }
  }
  return null
}

/** Config with the settings-env key merged in when userConfig gave none. Cached per session. */
let keySource: string = 'userConfig'
let resolved: Config | null = null
async function currentConfig($: any, base: Config): Promise<Config> {
  if (resolved) return resolved
  if (base.apiKey) {
    resolved = base
    return resolved
  }
  const found = await keyFromSettings($)
  if (found) {
    keySource = `settings env ${found.source}`
    resolved = { ...base, apiKey: found.key, apiKeyIssue: null }
  } else {
    resolved = base
  }
  return resolved
}

// ---- persisted toggle ---------------------------------------------------

async function getEnabled($: any, cfg: Config): Promise<boolean> {
  try {
    const v = await $.store.get(STORE_ENABLED)
    if (typeof v === 'boolean') return v
    if (v === 'true') return true
    if (v === 'false') return false
  } catch {
    // store unavailable: fall through to the default
  }
  return defaultEnabled(cfg)
}

async function setEnabled($: any, value: boolean): Promise<void> {
  try {
    await $.store.set(STORE_ENABLED, value)
  } catch {
    // store unavailable: the toggle only lasts until reload
  }
}

// ---- decision sources ---------------------------------------------------

/** Ask Jev. `prompt` is already redacted and truncated. Whole call (fetch + body + parse) under one deadline. */
/**
 * The body of a $.http.fetch result. The engine (2.1.283) returns it already
 * read, as `text: string` (and possibly `json`); a Response-like value with
 * `json()` / `text()` methods is accepted too.
 */
async function bodyJson(res: any): Promise<unknown> {
  if (res && typeof res === 'object') {
    if (typeof res.json === 'function') return await res.json()
    if (typeof res.text === 'function') return JSON.parse(await res.text())
    if (typeof res.text === 'string') return JSON.parse(res.text)
    if (typeof res.body === 'string') return JSON.parse(res.body)
    if (res.json !== undefined && typeof res.json === 'object') return res.json
    if (res.body !== undefined && typeof res.body === 'object' && res.body !== null && !('getReader' in res.body)) return res.body
  }
  if (typeof res === 'string') return JSON.parse(res)
  throw new Error('response has no readable body')
}

async function askJev($: any, cfg: Config, prompt: string, prevTier: Tier | null): Promise<Answers | null> {
  const req = buildRequest(prompt, prevTier, cfg)
  const controller = newAbortController()
  const init: Record<string, unknown> = { method: req.method, headers: req.headers, body: req.body }
  if (controller) init.signal = controller.signal

  const result = await withDeadline($, cfg.timeoutMs, controller, async () => {
    const res: any = await $.http.fetch(req.url, init)
    const status: number = typeof res?.status === 'number' ? res.status : 0
    const ok: boolean = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300
    if (!ok) {
      lastError = `jev: ${describeStatus(status)}`
      return null
    }
    const json = await bodyJson(res)
    const answers = parseResponse(json)
    if (!answers) lastError = 'jev: unparseable response'
    return answers
  })
  if (result === undefined) {
    lastError = 'jev: no timer available; routing skipped'
    return null
  }
  return result
}

/** Built-in classifier under the same budget as Jev. `prompt` is already redacted and truncated. */
async function askBuiltin($: any, cfg: Config, prompt: string): Promise<Answers | null> {
  const result = await withDeadline($, cfg.timeoutMs, null, async () => {
    const label = await $.model.classify(prompt, [...CLASSIFY_LABELS])
    if (!isTier(label)) return null
    return { tier: label, confidence: 1, risky: null } as Answers
  })
  if (result === undefined) {
    lastError = 'builtin: no timer available; routing skipped'
    return null
  }
  return result
}

// ---- /route text --------------------------------------------------------

function describeSource(cfg: Config): string {
  const src = routingSource(cfg)
  if (src === 'jev') return `Jev via ${cfg.provider} (${redactUrl(cfg.baseUrl)})`
  if (src === 'builtin') return 'built-in classifier (no Jev API key configured)'
  return 'nothing: no API key and fallback_classifier is off; run /route setup'
}

async function statusReport($: any, cfg: Config, enabled: boolean): Promise<string> {
  const last = await read($, lastAtom)
  const lines: string[] = [
    `${$.plugin.name} status`,
    `  enabled:      ${enabled ? 'yes' : 'no'}`,
    `  provider:     ${cfg.provider}`,
    `  base URL:     ${cfg.baseUrl ? redactUrl(cfg.baseUrl) : '(none: set jev_base_url)'}`,
    `  API key:      ${cfg.apiKey ? `present (${cfg.apiKey.length} chars, from ${keySource})` : cfg.apiKeyIssue ? `invalid: ${cfg.apiKeyIssue}` : 'missing (userConfig jev_api_key, or settings env JEV_API_KEY / AI_GATEWAY_API_KEY / TYPESAFE_API_KEY)'}`,
    `  jev model:    ${cfg.model}`,
    `  source:       ${routingSource(cfg) ?? 'none'}`,
    `  models:       fast=${cfg.models.fast}  balanced=${cfg.models.balanced}  powerful=${cfg.models.powerful}`,
    `  thresholds:   upgrade>=${cfg.upgradeConfidence}  downgrade>=${cfg.downgradeConfidence}  risky>=0.7`,
    `  effort:       ${cfg.routeEffort ? 'routed with tier (never for haiku)' : 'untouched'}`,
    `  timeout:      ${cfg.timeoutMs}ms`,
    `  fallback:     ${cfg.fallbackClassifier ? 'built-in classifier when no key' : 'off'}`,
  ]
  if (cfg.configError) lines.push(`  config error: ${cfg.configError}`)
  if (last) {
    const risky = last.risky !== null ? `  risky=${last.risky.toFixed(2)}` : ''
    const kept = last.rewrite === false || last.rewriteModel === false ? ' (kept)' : ''
    lines.push(
      `  last:         ${last.tier}${kept}  model=${last.model}  conf=${last.confidence.toFixed(2)}${risky}  effort=${last.effort}  ${last.latencyMs ?? '?'}ms  via ${last.source}`,
    )
  } else {
    lines.push('  last:         (no decision yet)')
  }
  if (lastError) lines.push(`  last error:   ${lastError}`)
  if (!hasJev(cfg)) lines.push('', 'No Jev API key configured: run /route setup.')
  return lines.join('\n')
}

function setupText($: any): string {
  return [
    `${$.plugin.name} setup`,
    '',
    '1. Run `/plugin configure jev-route` and set:',
    '   - provider: typesafe (api.typesafe.ai), gateway (Vercel AI Gateway) or custom',
    '   - jev_api_key: your TypeSafe or Vercel AI Gateway key. It is marked sensitive,',
    '     so Claude Code stores it in secure storage, never in settings.json.',
    '     If that value does not stick (known issue with session-loaded plugins), put the',
    '     key in the "env" block of ~/.claude/settings.json instead, as JEV_API_KEY',
    '     (or AI_GATEWAY_API_KEY / TYPESAFE_API_KEY), then /reload-plugins.',
    '   - jev_base_url: only for provider=custom (or to override the default endpoint).',
    '     Must be https (plain http only for localhost/127.0.0.1).',
    '   - model_fast / model_balanced / model_powerful: model ids per tier',
    '     (defaults claude-haiku-4-5 / claude-sonnet-5-5 / claude-opus-5-5)',
    '2. Hooks modules are early access: Claude Code must run with',
    '   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 (e.g. in settings.json under "env").',
    '3. `/route status` shows the resolved configuration; `/route off` pauses routing.',
    '',
    'Without a key, the built-in classifier is used when fallback_classifier is on.',
  ].join('\n')
}

// ---- hooks --------------------------------------------------------------

export const register: Register = (on, options) => {
  const base: Config = resolveConfig(options)
  resolved = null
  keySource = 'userConfig'

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'route',
        description: 'Toggle Jev model routing',
        argumentHint: '[on|off|status|setup]',
      })
      const cfg = await currentConfig($, base)
      const enabled = await getEnabled($, cfg)
      const last = await read($, lastAtom)
      $.ui.status(statusText(last, enabled))
    } catch {
      // never block session start
    }
    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const ev = asRecord(e)
    const arg = String(ev.args ?? '')
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
    try {
      const cfg = await currentConfig($, base)
      const enabled = await getEnabled($, cfg)
      if (arg === 'status') return { text: await statusReport($, cfg, enabled) }
      if (arg === 'setup') return { text: setupText($) }

      let value: boolean
      if (arg === 'on') value = true
      else if (arg === 'off') value = false
      else if (arg === '' || arg === undefined || arg === 'toggle') value = !enabled
      else return { text: `Unknown argument "${arg}". Usage: /route [on|off|status|setup]` }

      // `/route off` only stops new decisions; turns already in flight keep theirs.
      await setEnabled($, value)
      $.ui.status(value ? statusText(await read($, lastAtom), true) : 'route: off')
      return { text: `${$.plugin.name}: routing ${value ? 'ON' : 'OFF'}. Source: ${describeSource(cfg)}.` }
    } catch (err) {
      return { text: `${$.plugin.name}: ${errorText(err)}` }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const ev = asRecord(e)
      const text = ev.text
      const cfg = await currentConfig($, base)
      if (!(await getEnabled($, cfg))) return next(e)
      if (!isEligible(text)) return next(e)

      const source = routingSource(cfg)
      if (!source) return next(e)

      const graded = truncateState(redactSecrets(text))
      const last = await read($, lastAtom)
      const prevTier: Tier | null = last ? last.tier : null
      const started = now()

      const answers = source === 'jev' ? await askJev($, cfg, graded, prevTier) : await askBuiltin($, cfg, graded)

      if (answers) {
        lastError = null
        const turnId = asId(ev.turnId)
        const decision = composeDecision(answers, cfg, source, {
          turnId,
          promptKey: promptKeyOf(text),
          latencyMs: now() - started,
          at: started,
        })
        await update($, unboundAtom, () => decision)
        if (turnId) await update($, pendingAtom, (p) => ({ ...(p ?? {}), [turnId]: decision }))
        if (cfg.logDecisions) {
          const risky = decision.risky !== null ? `, risky ${decision.risky.toFixed(2)}` : ''
          $.ui.toast(`route: ${decision.tier} (${decision.confidence.toFixed(2)}${risky}) via ${source} in ${decision.latencyMs}ms`)
        }
      } else {
        await update($, unboundAtom, () => null)
        $.ui.status('route: on')
      }
    } catch (err) {
      lastError = errorText(err)
      try {
        await update($, unboundAtom, () => null)
        $.ui.status('route: on')
      } catch {
        // ignore
      }
    }
    return next(e)
  })

  // Bind the decision composed at prompt.submit to the turn that runs that prompt.
  on('turn.start', async ($, e, next) => {
    try {
      const ev = asRecord(e)
      const turnId = asId(ev.turnId)
      const unbound = await read($, unboundAtom)
      if (unbound && turnId && typeof ev.text === 'string' && promptKeyOf(ev.text) === unbound.promptKey) {
        const agentId = asId(ev.agentId)
        const bound: Decision = { ...unbound, turnId }
        if (agentId) bound.agentId = agentId
        else delete bound.agentId
        await update($, pendingAtom, (p) => ({ ...(p ?? {}), [turnId]: bound }))
        await update($, unboundAtom, () => null)
      }
    } catch {
      // never block the turn
    }
    return next(e)
  })

  // turn.step streams: the hook is an async generator that forwards the chunks
  // from next() and returns its result.
  on('turn.step', async function* ($, e, next) {
    let patch: typeof e = e
    try {
      const cfg = await currentConfig($, base)
      const ev = asRecord(e)
      const turnId = asId(ev.turnId)
      if (turnId) {
        const pending = (await read($, pendingAtom)) ?? {}
        let d: Decision | undefined = pending[turnId]
        if (d && sameAgent(d.agentId, asId(ev.agentId))) {
          if (d.rewrite === undefined) {
            // First step of the turn: settle the decision against the session model, once.
            const settled = resolveDecision(d, describeSession(ev.model, cfg), cfg)
            d = settled
            await update($, pendingAtom, (p) => ({ ...(p ?? {}), [turnId]: settled }))
            $.ui.status(statusText(settled, true))
          }
          const change = stepPatch(d, cfg)
          if (change) patch = { ...ev, ...change } as typeof e
        }
      }
    } catch {
      patch = e
    }
    return yield* next(patch)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const ev = asRecord(e)
      const turnId = asId(ev.turnId)
      const agentId = asId(ev.agentId)
      const pending = (await read($, pendingAtom)) ?? {}
      const d = turnId ? pending[turnId] : undefined
      if (d && turnId && sameAgent(d.agentId, agentId)) {
        await update($, lastAtom, () => d)
        await update($, pendingAtom, (p) => {
          const rest = { ...(p ?? {}) }
          delete rest[turnId]
          return rest
        })
      } else if (agentId === undefined) {
        // The main agent finished a turn we did not route: `previous_tier` must not
        // point at an older turn than the one just completed.
        await update($, lastAtom, () => null)
      }
      // Other agents' completions without a matching entry are ignored.
    } catch {
      // ignore
    }
    return next(e)
  })
}

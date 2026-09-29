// resolveConfig(options) → Config. Pure: no 'claude-code', no Node imports.

import type { Tier } from './types.ts'

export type Provider = 'typesafe' | 'gateway' | 'custom'

export interface Config {
  provider: Provider
  apiKey: string | undefined
  /** Why the configured API key was rejected (shown by /route status); null when fine or absent. */
  apiKeyIssue: string | null
  /** Base URL without trailing slash; '' when unknown (custom provider, no URL) or refused. */
  baseUrl: string
  /** Why the configured base URL was refused (shown by /route status); null when fine. */
  configError: string | null
  model: string
  models: Record<Tier, string>
  upgradeConfidence: number
  downgradeConfidence: number
  timeoutMs: number
  routeEffort: boolean
  fallbackClassifier: boolean
  logDecisions: boolean
}

export const PROVIDER_BASE_URLS: Record<Exclude<Provider, 'custom'>, string> = {
  typesafe: 'https://api.typesafe.ai',
  gateway: 'https://ai-gateway.vercel.sh/typesafe',
}

export const TIMEOUT_MIN_MS = 50
export const TIMEOUT_MAX_MS = 5000

export const DEFAULTS = {
  provider: 'typesafe' as Provider,
  jev_base_url: '',
  jev_model: 'jev-latest',
  model_fast: 'claude-haiku-4-5',
  model_balanced: 'claude-sonnet-5-5',
  model_powerful: 'claude-opus-5-5',
  upgrade_confidence: 0.3,
  downgrade_confidence: 0.6,
  timeout_ms: 800,
  route_effort: true,
  fallback_classifier: true,
  log_decisions: false,
} as const

type Options = Record<string, unknown>

function isRecord(v: unknown): v is Options {
  return typeof v === 'object' && v !== null
}

/**
 * Read one userConfig key from the `options` argument of register(on, options).
 * The exact shape is unverified, so accept options.<key>, options.userConfig.<key>
 * and options.options.<key>, in that order.
 */
export function readOption(options: unknown, key: string): unknown {
  if (!isRecord(options)) return undefined
  if (options[key] !== undefined) return options[key]
  const nested = [options.userConfig, options.options, options.config]
  for (const n of nested) {
    if (isRecord(n) && n[key] !== undefined) return n[key]
  }
  return undefined
}

export function asString(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fallback
}

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

export function asBoolean(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  }
  if (typeof v === 'number') return v !== 0
  return fallback
}

export function normalizeProvider(v: unknown): Provider {
  const s = asString(v, DEFAULTS.provider).toLowerCase()
  if (s === 'typesafe' || s === 'gateway' || s === 'custom') return s
  if (s === 'vercel' || s === 'ai-gateway') return 'gateway'
  return DEFAULTS.provider
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Base URL for a provider; an explicit `custom` URL always wins. Not yet validated. */
export function providerBaseUrl(provider: Provider, customUrl: string = ''): string {
  const explicit = stripSlash(customUrl.trim())
  if (explicit !== '') return explicit
  if (provider === 'custom') return ''
  return PROVIDER_BASE_URLS[provider]
}

// URL parsing without the `URL` global (not part of lib es2023).
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@\/\s]*)@)?([^\/:?#\s]+)/i

export interface UrlParts {
  scheme: string
  userinfo: string | undefined
  host: string
}

export function parseUrl(url: string): UrlParts | null {
  const m = URL_RE.exec(url.trim())
  if (!m) return null
  return { scheme: m[1].toLowerCase(), userinfo: m[2], host: m[3].toLowerCase() }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/** A base URL must be https, except plain http to localhost/127.0.0.1. '' is fine (no endpoint). */
export function validateBaseUrl(url: string): { url: string; error: string | null } {
  if (url === '') return { url: '', error: null }
  const parts = parseUrl(url)
  if (!parts) return { url: '', error: `jev_base_url "${redactUrl(url)}" is not a valid http(s) URL` }
  if (parts.scheme === 'https') return { url, error: null }
  if (parts.scheme === 'http' && isLoopbackHost(parts.host)) return { url, error: null }
  return { url: '', error: `jev_base_url "${redactUrl(url)}" refused: only https is allowed (http only for localhost/127.0.0.1)` }
}

/** The URL with any `user:pass@` userinfo replaced, safe to print. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@\/\s]*@/i, '$1[REDACTED]@')
}

function nonEmpty(s: string, fallback: string): string {
  return s === '' ? fallback : s
}

export function resolveConfig(options: unknown): Config {
  const provider = normalizeProvider(readOption(options, 'provider'))
  const key = checkApiKey(readOption(options, 'jev_api_key'))
  const checked = validateBaseUrl(providerBaseUrl(provider, asString(readOption(options, 'jev_base_url'), '')))
  return {
    provider,
    apiKey: key.apiKey,
    apiKeyIssue: key.issue,
    baseUrl: checked.url,
    configError: checked.error,
    model: nonEmpty(asString(readOption(options, 'jev_model'), DEFAULTS.jev_model), DEFAULTS.jev_model),
    models: {
      fast: nonEmpty(asString(readOption(options, 'model_fast'), DEFAULTS.model_fast), DEFAULTS.model_fast),
      balanced: nonEmpty(asString(readOption(options, 'model_balanced'), DEFAULTS.model_balanced), DEFAULTS.model_balanced),
      powerful: nonEmpty(asString(readOption(options, 'model_powerful'), DEFAULTS.model_powerful), DEFAULTS.model_powerful),
    },
    upgradeConfidence: clamp01(asNumber(readOption(options, 'upgrade_confidence'), DEFAULTS.upgrade_confidence)),
    downgradeConfidence: clamp01(asNumber(readOption(options, 'downgrade_confidence'), DEFAULTS.downgrade_confidence)),
    timeoutMs: clamp(asNumber(readOption(options, 'timeout_ms'), DEFAULTS.timeout_ms), TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
    routeEffort: asBoolean(readOption(options, 'route_effort'), DEFAULTS.route_effort),
    fallbackClassifier: asBoolean(readOption(options, 'fallback_classifier'), DEFAULTS.fallback_classifier),
    logDecisions: asBoolean(readOption(options, 'log_decisions'), DEFAULTS.log_decisions),
  }
}

/**
 * An HTTP header value must be printable ASCII; a key with anything else (a
 * masked placeholder such as "••••", a stray newline, a pasted zero-width
 * character) makes the fetch layer refuse the Authorization header outright.
 */
export function checkApiKey(raw: unknown): { apiKey: string | undefined; issue: string | null } {
  if (raw === undefined || raw === null || raw === '') return { apiKey: undefined, issue: null }
  if (typeof raw !== 'string') return { apiKey: undefined, issue: `API key is a ${typeof raw}, not a string` }
  const key = raw.trim()
  if (key === '') return { apiKey: undefined, issue: null }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    const bad = [...key].filter((c) => !/[\x21-\x7e]/.test(c))
    const codes = [...new Set(bad.map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')))].slice(0, 4)
    return {
      apiKey: undefined,
      issue: `API key (${key.length} chars) contains non-printable or non-ASCII characters (${codes.join(' ')}); re-enter it as plain text`,
    }
  }
  return { apiKey: key, issue: null }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function clamp01(n: number): number {
  return clamp(n, 0, 1)
}

/** True when a Jev call can be made at all (key + endpoint present). */
export function hasJev(cfg: Config): boolean {
  return cfg.apiKey !== undefined && cfg.baseUrl !== ''
}

/** Default value of the persisted `enabled` toggle when the store has none. */
export function defaultEnabled(cfg: Config): boolean {
  return hasJev(cfg) || cfg.fallbackClassifier
}

/** Which decision source the config allows: 'jev', 'builtin' or none. */
export function routingSource(cfg: Config): 'jev' | 'builtin' | null {
  if (hasJev(cfg)) return 'jev'
  if (cfg.fallbackClassifier) return 'builtin'
  return null
}

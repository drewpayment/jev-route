// isEligible(prompt) / redactSecrets(text) / truncateState(prompt). Pure.

export const MIN_PROMPT_CHARS = 3
export const MAX_STATE_CHARS = 20_000
export const REDACTED = '[REDACTED]'

/** Whole-match credential patterns; every match is replaced by REDACTED. */
export const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b[sr]k_live_[A-Za-z0-9]{10,}\b/g, // Stripe live keys
]

/** `scheme://user:pass@host` → the userinfo is redacted. */
const URL_USERINFO = /(:\/\/)[^\s/:@]+:[^@\s]+@/g

/** `password = "value"`-style assignments; the value is checked before redaction. */
const KEYWORD_ASSIGN = /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*['"]?)([A-Za-z0-9_\-/+.]{12,})(['"]?)/gi

/** `Bearer <token>`; placeholders are left alone. */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9_\-.=]{20,})/gi

const TYPE_NAMES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null', 'str', 'int', 'float', 'bool'])

/** ALL_CAPS placeholders, type names, dotted code paths and template expressions are not secrets. */
export function isPlaceholder(value: string): boolean {
  if (/^[A-Z0-9_]+$/.test(value)) return true
  if (TYPE_NAMES.has(value.toLowerCase())) return true
  if (value.startsWith('${') || value.startsWith('{{')) return true
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)) return true // process.env.X, config.auth.token
  return false
}

/** Replace anything that looks like a credential with REDACTED. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`)
  out = out.replace(KEYWORD_ASSIGN, (match: string, kw: string, sep: string, value: string, quote: string, offset: number, whole: string) => {
    if (isPlaceholder(value)) return match
    const before = whole[offset + kw.length + sep.length - 1] ?? ''
    if (before === '$' || before === '{') return match
    const after = whole[offset + match.length] ?? ''
    if (after === '(' || after === ')' || after === '{') return match
    return `${kw}${sep}${REDACTED}${quote}`
  })
  out = out.replace(BEARER, (match: string, prefix: string, value: string) => (isPlaceholder(value) ? match : `${prefix}${REDACTED}`))
  return out
}

/** True when redaction would change the text. */
export function looksLikeSecret(text: string): boolean {
  return redactSecrets(text) !== text
}

/** Should this prompt be graded at all? Only length matters; secrets are redacted, not skipped. */
export function isEligible(prompt: unknown): prompt is string {
  if (typeof prompt !== 'string') return false
  if (prompt.trim().length < MIN_PROMPT_CHARS) return false
  return true
}

/** Head+tail truncation so the state sent to Jev never exceeds `max` chars (marker included). */
export function truncateState(prompt: string, max: number = MAX_STATE_CHARS): string {
  if (prompt.length <= max) return prompt
  const marker = (n: number) => `\n…[${n} chars omitted]…\n`
  let omitted = prompt.length - max
  let out = ''
  // The marker's digit count depends on the omitted count, which depends on the marker length;
  // iterate until it stabilises (at most a couple of rounds).
  for (let i = 0; i < 4; i++) {
    const budget = Math.max(0, max - marker(omitted).length)
    const head = Math.ceil(budget / 2)
    const tail = budget - head
    const actual = prompt.length - head - tail
    out = prompt.slice(0, head) + marker(actual) + (tail > 0 ? prompt.slice(prompt.length - tail) : '')
    if (out.length <= max) return out
    omitted = actual
  }
  return out.slice(0, max)
}

import { describe, expect, test } from 'bun:test'
import {
  DEFAULTS,
  defaultEnabled,
  hasJev,
  normalizeProvider,
  providerBaseUrl,
  readOption,
  redactUrl,
  resolveConfig,
  routingSource,
  validateBaseUrl,
} from '../hooks/config.ts'

describe('providerBaseUrl', () => {
  test('typesafe and gateway derive from provider', () => {
    expect(providerBaseUrl('typesafe')).toBe('https://api.typesafe.ai')
    expect(providerBaseUrl('gateway')).toBe('https://ai-gateway.vercel.sh/typesafe')
  })
  test('custom requires an explicit URL', () => {
    expect(providerBaseUrl('custom')).toBe('')
    expect(providerBaseUrl('custom', 'https://jev.internal/')).toBe('https://jev.internal')
  })
  test('explicit URL overrides any provider and loses trailing slashes', () => {
    expect(providerBaseUrl('typesafe', 'https://proxy.example.com/typesafe//')).toBe('https://proxy.example.com/typesafe')
  })
})

describe('resolveConfig', () => {
  test('all defaults when options are missing', () => {
    const c = resolveConfig(undefined)
    expect(c.provider).toBe('typesafe')
    expect(c.apiKey).toBeUndefined()
    expect(c.baseUrl).toBe('https://api.typesafe.ai')
    expect(c.model).toBe(DEFAULTS.jev_model)
    expect(c.models).toEqual({ fast: 'claude-haiku-4-5', balanced: 'claude-sonnet-5-5', powerful: 'claude-opus-5-5' })
    expect(c.configError).toBeNull()
    expect(c.upgradeConfidence).toBe(0.3)
    expect(c.downgradeConfidence).toBe(0.6)
    expect(c.timeoutMs).toBe(800)
    expect(c.routeEffort).toBe(true)
    expect(c.fallbackClassifier).toBe(true)
    expect(c.logDecisions).toBe(false)
  })
  test('reads flat, userConfig-nested and options-nested shapes', () => {
    expect(resolveConfig({ timeout_ms: 300 }).timeoutMs).toBe(300)
    expect(resolveConfig({ userConfig: { timeout_ms: 400 } }).timeoutMs).toBe(400)
    expect(resolveConfig({ options: { timeout_ms: 500 } }).timeoutMs).toBe(500)
    expect(readOption({ options: { provider: 'gateway' } }, 'provider')).toBe('gateway')
    expect(readOption(null, 'provider')).toBeUndefined()
  })
  test('gateway provider and custom base URL', () => {
    expect(resolveConfig({ provider: 'gateway' }).baseUrl).toBe('https://ai-gateway.vercel.sh/typesafe')
    const custom = resolveConfig({ provider: 'custom', jev_base_url: 'http://localhost:8080/' })
    expect(custom.provider).toBe('custom')
    expect(custom.baseUrl).toBe('http://localhost:8080')
    expect(resolveConfig({ provider: 'custom' }).baseUrl).toBe('')
  })
  test('unknown provider falls back to typesafe; vercel alias → gateway', () => {
    expect(normalizeProvider('bogus')).toBe('typesafe')
    expect(normalizeProvider('Vercel')).toBe('gateway')
    expect(normalizeProvider('GATEWAY')).toBe('gateway')
  })
  test('coerces strings for numbers and booleans', () => {
    const c = resolveConfig({ upgrade_confidence: '0.45', route_effort: 'false', fallback_classifier: 'no', log_decisions: '1' })
    expect(c.upgradeConfidence).toBe(0.45)
    expect(c.routeEffort).toBe(false)
    expect(c.fallbackClassifier).toBe(false)
    expect(c.logDecisions).toBe(true)
  })
  test('bad numbers fall back to defaults; confidences clamp to 0..1; timeout clamps to 50..5000', () => {
    const c = resolveConfig({ upgrade_confidence: 'abc', downgrade_confidence: 5, timeout_ms: -100 })
    expect(c.upgradeConfidence).toBe(0.3)
    expect(c.downgradeConfidence).toBe(1)
    expect(c.timeoutMs).toBe(50)
    expect(resolveConfig({ timeout_ms: 99_999 }).timeoutMs).toBe(5000)
    expect(resolveConfig({ timeout_ms: 5000 }).timeoutMs).toBe(5000)
    expect(resolveConfig({ timeout_ms: 'nope' }).timeoutMs).toBe(800)
  })
  test('empty model strings fall back to defaults', () => {
    expect(resolveConfig({ model_fast: '  ', jev_model: '' }).models.fast).toBe('claude-haiku-4-5')
    expect(resolveConfig({ jev_model: '' }).model).toBe('jev-latest')
  })
  test('api key is trimmed; blank means missing', () => {
    expect(resolveConfig({ jev_api_key: '  k1  ' }).apiKey).toBe('k1')
    expect(resolveConfig({ jev_api_key: '   ' }).apiKey).toBeUndefined()
  })
})

describe('routing source and default toggle', () => {
  test('key + url → jev', () => {
    const c = resolveConfig({ jev_api_key: 'k' })
    expect(hasJev(c)).toBe(true)
    expect(routingSource(c)).toBe('jev')
    expect(defaultEnabled(c)).toBe(true)
  })
  test('custom provider without URL is not a Jev endpoint', () => {
    const c = resolveConfig({ jev_api_key: 'k', provider: 'custom' })
    expect(hasJev(c)).toBe(false)
    expect(routingSource(c)).toBe('builtin')
  })
  test('no key → builtin when fallback allowed, else none and disabled by default', () => {
    expect(routingSource(resolveConfig({}))).toBe('builtin')
    expect(defaultEnabled(resolveConfig({}))).toBe(true)
    const off = resolveConfig({ fallback_classifier: false })
    expect(routingSource(off)).toBeNull()
    expect(defaultEnabled(off)).toBe(false)
  })
})

describe('base URL safety', () => {
  test('https is accepted; http only for loopback hosts', () => {
    expect(validateBaseUrl('https://jev.example.com')).toEqual({ url: 'https://jev.example.com', error: null })
    expect(validateBaseUrl('http://localhost:8080')).toEqual({ url: 'http://localhost:8080', error: null })
    expect(validateBaseUrl('http://127.0.0.1')).toEqual({ url: 'http://127.0.0.1', error: null })
    expect(validateBaseUrl('')).toEqual({ url: '', error: null })
  })
  test('non-https elsewhere is refused with a configError and no endpoint', () => {
    const c = resolveConfig({ jev_api_key: 'k', provider: 'custom', jev_base_url: 'http://jev.example.com/' })
    expect(c.baseUrl).toBe('')
    expect(c.configError).toContain('https')
    expect(hasJev(c)).toBe(false)
    expect(routingSource(c)).toBe('builtin')
    expect(resolveConfig({ jev_base_url: 'ftp://x.y' }).baseUrl).toBe('')
    expect(resolveConfig({ jev_base_url: 'not a url' }).configError).toContain('not a valid')
  })
  test('userinfo is redacted in errors and by redactUrl', () => {
    expect(redactUrl('https://alice:s3cret@jev.example.com/v1')).toBe('https://[REDACTED]@jev.example.com/v1')
    expect(redactUrl('https://jev.example.com')).toBe('https://jev.example.com')
    const c = resolveConfig({ jev_base_url: 'http://alice:s3cret@jev.example.com' })
    expect(c.configError).not.toContain('s3cret')
    expect(c.configError).toContain('[REDACTED]@')
  })
})

import { checkApiKey } from '../hooks/config.ts'

describe('checkApiKey', () => {
  test('accepts a printable ASCII key and trims whitespace', () => {
    expect(checkApiKey('  vck_abc123XYZ-_.  ')).toEqual({ apiKey: 'vck_abc123XYZ-_.', issue: null })
  })
  test('empty or missing is absent, not an issue', () => {
    expect(checkApiKey(undefined)).toEqual({ apiKey: undefined, issue: null })
    expect(checkApiKey('')).toEqual({ apiKey: undefined, issue: null })
    expect(checkApiKey('   ')).toEqual({ apiKey: undefined, issue: null })
  })
  test('rejects a masked placeholder and names the code point', () => {
    const r = checkApiKey('••••••••')
    expect(r.apiKey).toBeUndefined()
    expect(r.issue).toContain('U+2022')
    expect(r.issue).toContain('8 chars')
  })
  test('rejects an embedded newline', () => {
    const r = checkApiKey('abc\ndef')
    expect(r.apiKey).toBeUndefined()
    expect(r.issue).toContain('U+000A')
  })
  test('rejects a non-string', () => {
    expect(checkApiKey({ value: 'x' }).issue).toContain('object')
  })
  test('resolveConfig surfaces the issue and leaves apiKey unset', () => {
    const cfg = resolveConfig({ jev_api_key: '••••' })
    expect(cfg.apiKey).toBeUndefined()
    expect(cfg.apiKeyIssue).toContain('U+2022')
  })
})

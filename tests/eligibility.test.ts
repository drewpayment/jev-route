import { describe, expect, test } from 'bun:test'
import { MAX_STATE_CHARS, REDACTED, isEligible, isPlaceholder, looksLikeSecret, redactSecrets, truncateState } from '../hooks/eligibility.ts'

describe('isEligible', () => {
  test('ordinary prompts are eligible', () => {
    expect(isEligible('fix the failing test in auth.ts')).toBe(true)
    expect(isEligible('yes')).toBe(true)
    expect(isEligible('why does this deploy fail?')).toBe(true)
  })
  test('too short or non-string prompts are not', () => {
    expect(isEligible('')).toBe(false)
    expect(isEligible('ok')).toBe(false)
    expect(isEligible('  y  ')).toBe(false)
    expect(isEligible(undefined)).toBe(false)
    expect(isEligible(42)).toBe(false)
  })
  test('secret-looking prompts stay eligible (they are redacted, not skipped)', () => {
    expect(isEligible('use this key sk-abcdefghijklmnop1234')).toBe(true)
    expect(isEligible('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----')).toBe(true)
  })
})

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const GOOGLE = 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'

describe('redactSecrets', () => {
  test('redacts credentials and keeps the surrounding text', () => {
    const out = redactSecrets(`connect with postgres://admin:hunter2@db:5432/app and api_key="${GOOGLE}" then sk-abcdefghijklmnop1234 and ${JWT}`)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('admin:')
    expect(out).toContain(`postgres://${REDACTED}@db:5432/app`)
    expect(out).not.toContain(GOOGLE)
    expect(out).toContain(`api_key="${REDACTED}"`)
    expect(out).not.toContain('sk-abcdefghijklmnop1234')
    expect(out).not.toContain(JWT)
    expect(out).toContain('connect with')
    expect(out).toContain('then')
  })
  test('each documented pattern', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTED)
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(REDACTED)
    expect(redactSecrets('sk_live_abcdefghij1234')).toBe(REDACTED)
    expect(redactSecrets('rk_live_abcdefghij1234')).toBe(REDACTED)
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED)
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe(`Authorization: Bearer ${REDACTED}`)
    expect(redactSecrets('set password=correcthorsebattery in the env')).toBe(`set password=${REDACTED} in the env`)
    expect(redactSecrets("secret: 'abcdefghijkl1234'")).toBe(`secret: '${REDACTED}'`)
    expect(redactSecrets('TOKEN = abcdefghijkl-mnop')).toBe(`TOKEN = ${REDACTED}`)
    expect(redactSecrets('api-key: abcdefghijklmnop')).toBe(`api-key: ${REDACTED}`)
  })
  test('non-secrets are untouched', () => {
    for (const s of [
      'add a password: string field',
      'user.password = hash(pw)',
      'Bearer YOUR_API_KEY_HERE',
      'explain bearer authentication',
      'the word bearer appears here alone',
      'reset my password please',
      'talk about the ask-me-anything',
      'api_key=${JEV_API_KEY}',
      'token: process.env.TOKEN_VALUE',
      'password: YOUR_PASSWORD_HERE_OK',
      'see https://example.com/path:with:colons',
      'password = getPassword(user)',
    ]) {
      expect(redactSecrets(s)).toBe(s)
      expect(looksLikeSecret(s)).toBe(false)
    }
  })
  test('placeholders', () => {
    expect(isPlaceholder('YOUR_API_KEY_HERE')).toBe(true)
    expect(isPlaceholder('string')).toBe(true)
    expect(isPlaceholder('${SECRET}')).toBe(true)
    expect(isPlaceholder('process.env.TOKEN')).toBe(true)
    expect(isPlaceholder('abcdefghijkl1234')).toBe(false)
  })
  test('idempotent', () => {
    const once = redactSecrets(`Bearer ${JWT} password=correcthorsebattery`)
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('truncateState', () => {
  test('short input is unchanged', () => {
    expect(truncateState('hello')).toBe('hello')
    const exact = 'x'.repeat(MAX_STATE_CHARS)
    expect(truncateState(exact)).toBe(exact)
  })
  test('long input keeps head and tail within the cap', () => {
    const head = 'H'.repeat(30_000)
    const tail = 'T'.repeat(30_000)
    const out = truncateState(head + tail)
    expect(out.length).toBeLessThanOrEqual(MAX_STATE_CHARS)
    expect(out.startsWith('HHHH')).toBe(true)
    expect(out.endsWith('TTTT')).toBe(true)
    expect(out).toMatch(/\[\d+ chars omitted\]/)
    const omitted = Number(/\[(\d+) chars omitted\]/.exec(out)![1])
    const kept = (out.match(/[HT]/g) ?? []).length
    expect(kept + omitted).toBe(60_000)
  })
  test('custom max', () => {
    const out = truncateState('abcdefghijklmnopqrstuvwxyz'.repeat(10), 60)
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out.startsWith('abc')).toBe(true)
    expect(out.endsWith('xyz')).toBe(true)
  })
  test('never exceeds max even when the omitted count gains a digit', () => {
    // omitted guess 99 (2 digits) but the real count is 121 (3 digits)
    expect(truncateState('x'.repeat(199), 100).length).toBeLessThanOrEqual(100)
    for (const [len, max] of [
      [1_009, 1_000],
      [10_000 + 9_999, 10_000],
      [MAX_STATE_CHARS + 1, MAX_STATE_CHARS],
      [MAX_STATE_CHARS * 6, MAX_STATE_CHARS],
      [50, 10],
      [50, 30],
    ] as const) {
      expect(truncateState('y'.repeat(len), max).length).toBeLessThanOrEqual(max)
    }
  })
})

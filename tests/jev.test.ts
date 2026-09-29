import { describe, expect, test } from 'bun:test'
import { buildRequest, buildRequestBody, describeStatus, parseResponse } from '../hooks/jev.ts'
import { MAX_STATE_CHARS } from '../hooks/eligibility.ts'
import { cfg } from './helpers.ts'

// Exact sample from docs/ENGINE-API.md
const SAMPLE = {
  model: 'jev-latest',
  answers: {
    risky: { type: 'noul', noul: 0.07 },
    tier: { type: 'choice', choice: 'fast', confidence: 1, probabilities: { fast: 1, balanced: 0, powerful: 0 } },
  },
  usage: { input_tokens: 376, output_tokens: 59 },
}

describe('parseResponse', () => {
  test('parses the documented sample', () => {
    const a = parseResponse(SAMPLE)
    expect(a).toEqual({ tier: 'fast', confidence: 1, risky: 0.07, probabilities: { fast: 1, balanced: 0, powerful: 0 } })
  })
  test('round-trips through JSON', () => {
    expect(parseResponse(JSON.parse(JSON.stringify(SAMPLE)))?.tier).toBe('fast')
  })
  test('confidence falls back to the chosen probability', () => {
    const a = parseResponse({ answers: { tier: { type: 'choice', choice: 'balanced', probabilities: { fast: 0.2, balanced: 0.7, powerful: 0.1 } } } })
    expect(a?.confidence).toBeCloseTo(0.7)
    expect(a?.risky).toBeNull()
  })
  test('missing confidence and probabilities → neutral 0.5', () => {
    const a = parseResponse({ answers: { tier: { type: 'choice', choice: 'balanced' } } })
    expect(a?.confidence).toBe(0.5)
    expect(a?.tier).toBe('balanced')
  })
  test('missing choice → argmax of probabilities with that probability as confidence', () => {
    const a = parseResponse({ answers: { tier: { probabilities: { fast: 0.15, balanced: 0.25, powerful: 0.6 } } } })
    expect(a?.tier).toBe('powerful')
    expect(a?.confidence).toBeCloseTo(0.6)
    const b = parseResponse({ answers: { tier: { choice: 'nonsense', probabilities: { fast: 0.9, balanced: 0.1 } } } })
    expect(b?.tier).toBe('fast')
    expect(b?.confidence).toBeCloseTo(0.9)
  })
  test('accepts the gateway native `probability` naming for risky', () => {
    const a = parseResponse({ answers: { tier: { choice: 'powerful', confidence: 0.8 }, risky: { probability: 0.9 } } })
    expect(a?.risky).toBeCloseTo(0.9)
  })
  test('clamps out-of-range numbers', () => {
    const a = parseResponse({ answers: { tier: { choice: 'fast', confidence: 1.7 }, risky: { noul: -0.2 } } })
    expect(a?.confidence).toBe(1)
    expect(a?.risky).toBe(0)
  })
  test('rejects garbage', () => {
    expect(parseResponse(null)).toBeNull()
    expect(parseResponse('nope')).toBeNull()
    expect(parseResponse({})).toBeNull()
    expect(parseResponse({ answers: {} })).toBeNull()
    expect(parseResponse({ answers: { tier: { choice: 'medium' } } })).toBeNull()
    expect(parseResponse({ answers: { tier: { probabilities: {} } } })).toBeNull()
    expect(parseResponse({ answers: { tier: { probabilities: { fast: 'high' } } } })).toBeNull()
    expect(parseResponse({ answers: { tier: 'fast' } })).toBeNull()
  })
})

describe('buildRequest', () => {
  test('targets <base>/v1/systemone with a bearer key and JSON body', () => {
    const req = buildRequest('fix the typo in README', 'balanced', cfg({ jev_api_key: 'sk-test-123' }))
    expect(req.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(req.method).toBe('POST')
    expect(req.headers.authorization).toBe('Bearer sk-test-123')
    expect(req.headers['content-type']).toBe('application/json')
    const body = JSON.parse(req.body)
    expect(body.model).toBe('jev-latest')
    expect(body.state).toEqual({ prompt: 'fix the typo in README', previous_tier: 'balanced' })
    expect(body.questions.tier.type).toBe('choice')
    expect(Object.keys(body.questions.tier.criteria).sort()).toEqual(['balanced', 'fast', 'powerful'])
    expect(body.questions.risky.type).toBe('noul')
    expect(typeof body.questions.tier.instructions).toBe('string')
    expect(typeof body.questions.risky.instructions).toBe('string')
  })
  test('omits previous_tier when absent', () => {
    const body = buildRequestBody('hello there', null, cfg())
    expect('previous_tier' in body.state).toBe(false)
  })
  test('uses the gateway base URL and custom jev_model', () => {
    const req = buildRequest('x'.repeat(10), undefined, cfg({ provider: 'gateway', jev_model: 'jev-2' }))
    expect(req.url).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone')
    expect(JSON.parse(req.body).model).toBe('jev-2')
  })
  test('truncates long prompts in the state', () => {
    const body = buildRequestBody('a'.repeat(50_000), null, cfg())
    expect(body.state.prompt.length).toBeLessThanOrEqual(MAX_STATE_CHARS)
    expect(body.state.prompt).toContain('chars omitted')
  })
  test('does not redact by itself (the caller does): state is passed through', () => {
    const body = buildRequestBody('token=abcdefghijklmnop', null, cfg())
    expect(body.state.prompt).toBe('token=abcdefghijklmnop')
  })
})

describe('describeStatus', () => {
  test('known codes', () => {
    expect(describeStatus(401)).toContain('unauthorized')
    expect(describeStatus(422)).toContain('validation')
    expect(describeStatus(429)).toContain('rate limited')
    expect(describeStatus(529)).toContain('overloaded')
    expect(describeStatus(500)).toBe('HTTP 500')
  })
})

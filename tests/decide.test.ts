import { describe, expect, test } from 'bun:test'
import {
  composeDecision,
  decide,
  describeSession,
  effortApplies,
  family,
  inferTier,
  normalizeModel,
  resolveDecision,
  statusText,
  stepPatch,
  tierEffort,
} from '../hooks/decide.ts'
import type { Answers } from '../hooks/types.ts'
import { cfg } from './helpers.ts'

const ans = (tier: Answers['tier'], confidence: number, risky: number | null = 0.05): Answers => ({ tier, confidence, risky })

const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

/** Settle answers against a session model id (as turn.step does). */
const settle = (a: Answers, sessionModel: string, c = cfg()) => resolveDecision(composeDecision(a, c, 'jev'), describeSession(sessionModel, c), c)

describe('tier → model mapping', () => {
  test('defaults map to full ids', () => {
    const c = cfg()
    expect(decide(ans('fast', 0.9), 'balanced', c)?.model).toBe(HAIKU)
    expect(decide(ans('powerful', 0.9), 'balanced', c)?.model).toBe(OPUS)
    expect(composeDecision(ans('balanced', 0.9), c, 'jev').model).toBe(SONNET)
  })

  test('custom map is honoured', () => {
    const c = cfg({ model_fast: 'claude-haiku-4-5', model_powerful: 'claude-opus-5' })
    expect(decide(ans('fast', 0.9), 'balanced', c)?.model).toBe('claude-haiku-4-5')
    expect(decide(ans('powerful', 0.9), 'balanced', c)?.model).toBe('claude-opus-5')
  })
})

describe('effort from tier', () => {
  test('fast/balanced/powerful → low/medium/high', () => {
    expect(tierEffort('fast', 0)).toBe('low')
    expect(tierEffort('balanced', 0)).toBe('medium')
    expect(tierEffort('powerful', 0)).toBe('high')
    expect(tierEffort('fast', null)).toBe('low')
  })
  test('risky → max', () => {
    expect(tierEffort('fast', 0.7)).toBe('max')
    expect(tierEffort('balanced', 0.99)).toBe('max')
  })
})

describe('hysteresis thresholds', () => {
  const c = cfg() // upgrade 0.3, downgrade 0.6

  test('upgrade at or above upgrade_confidence', () => {
    expect(decide(ans('powerful', 0.3), 'balanced', c)?.tier).toBe('powerful')
    expect(decide(ans('powerful', 0.3), 'balanced', c)?.rewriteModel).toBe(true)
    expect(decide(ans('powerful', 0.31), 'fast', c)?.tier).toBe('powerful')
    expect(decide(ans('balanced', 0.3), 'fast', c)?.tier).toBe('balanced')
  })
  test('no upgrade below upgrade_confidence: model kept, effort of the current tier', () => {
    const d = decide(ans('powerful', 0.29), 'balanced', c)!
    expect(d.rewriteModel).toBe(false)
    expect(d.tier).toBe('balanced')
    expect(d.model).toBe(SONNET)
    expect(d.effort).toBe('medium')
  })
  test('downgrade at or above downgrade_confidence', () => {
    expect(decide(ans('fast', 0.6), 'balanced', c)?.tier).toBe('fast')
    expect(decide(ans('balanced', 0.61), 'powerful', c)?.tier).toBe('balanced')
  })
  test('no downgrade below downgrade_confidence', () => {
    expect(decide(ans('fast', 0.59), 'balanced', c)?.rewriteModel).toBe(false)
    expect(decide(ans('fast', 0.45), 'powerful', c)?.rewriteModel).toBe(false)
  })
  test('same tier → keep the model, route effort only', () => {
    const kept = resolveDecision(composeDecision(ans('balanced', 1), c, 'jev'), 'balanced', c)
    expect(kept.rewriteModel).toBe(false)
    expect(kept.rewrite).toBe(true)
    expect(kept.tier).toBe('balanced')
    expect(stepPatch(kept, c)).toEqual({ effort: 'medium' })
  })
  test('same tier with route_effort off → nothing to rewrite', () => {
    const c2 = cfg({ route_effort: false })
    expect(decide(ans('balanced', 1), 'balanced', c2)).toBeNull()
    const kept = resolveDecision(composeDecision(ans('fast', 0.2), c2, 'jev'), 'balanced', c2)
    expect(kept.rewrite).toBe(false)
    expect(stepPatch(kept, c2)).toBeNull()
  })
  test('custom thresholds', () => {
    const c2 = cfg({ upgrade_confidence: 0.5, downgrade_confidence: 0.9 })
    expect(decide(ans('powerful', 0.45), 'balanced', c2)?.rewriteModel).toBe(false)
    expect(decide(ans('powerful', 0.5), 'balanced', c2)?.tier).toBe('powerful')
    expect(decide(ans('fast', 0.85), 'balanced', c2)?.rewriteModel).toBe(false)
    expect(decide(ans('fast', 0.9), 'balanced', c2)?.tier).toBe('fast')
  })
  test('kept decision reports the current tier and its model', () => {
    const kept = resolveDecision(composeDecision(ans('fast', 0.2), c, 'jev'), 'powerful', c)
    expect(kept.rewriteModel).toBe(false)
    expect(kept.tier).toBe('powerful')
    expect(kept.requested).toBe('fast')
    expect(kept.model).toBe(OPUS)
    expect(kept.effort).toBe('high')
  })
})

describe('risky override', () => {
  const c = cfg()
  test('risky >= 0.7 forces powerful with effort max regardless of tier/confidence', () => {
    const d = decide(ans('fast', 0.1, 0.7), 'balanced', c)
    expect(d?.tier).toBe('powerful')
    expect(d?.effort).toBe('max')
    expect(d?.model).toBe(OPUS)
    expect(d?.requested).toBe('powerful')
    expect(d?.rewriteModel).toBe(true)
  })
  test('risky on an already-powerful session keeps the exact session model and rewrites effort only', () => {
    const d = settle(ans('powerful', 0.2, 0.95), 'claude-opus-5')
    expect(d.rewrite).toBe(true)
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe('claude-opus-5')
    expect(d.effort).toBe('max')
    expect(stepPatch(d, c)).toEqual({ effort: 'max' })
  })
  test('risky below 0.7 does not override', () => {
    expect(decide(ans('fast', 0.9, 0.69), 'balanced', c)?.tier).toBe('fast')
  })
  test('risky null is ignored', () => {
    expect(decide(ans('fast', 0.9, null), 'balanced', c)?.tier).toBe('fast')
    expect(decide(ans('fast', 0.9, null), 'balanced', c)?.effort).toBe('low')
  })
})

describe('model id normalisation and families', () => {
  test('strips [1m] and date suffixes', () => {
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModel('claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(normalizeModel('Claude-Sonnet-5-20260101[1m]')).toBe('claude-sonnet-5')
    expect(normalizeModel('opus')).toBe('opus')
  })
  test('family from aliases and ids', () => {
    expect(family('haiku')).toBe('haiku')
    expect(family('claude-sonnet-5-5')).toBe('sonnet')
    expect(family('claude-opus-5-5[1m]')).toBe('opus')
    expect(family('claude-fable-5-1')).toBe('fable')
    expect(family('gpt-5')).toBeNull()
  })
})

describe('current-tier inference from model ids', () => {
  const c = cfg()
  test('full ids match by family', () => {
    expect(inferTier('claude-sonnet-5-5', c)).toBe('balanced')
    expect(inferTier('claude-opus-5-5', c)).toBe('powerful')
    expect(inferTier('claude-opus-5', c)).toBe('powerful')
    expect(inferTier('claude-haiku-4-5', c)).toBe('fast')
    expect(inferTier('claude-haiku-4-5', c)).toBe('fast')
    expect(inferTier('claude-sonnet-5[1m]', c)).toBe('balanced')
  })
  test('aliases match', () => {
    expect(inferTier('sonnet', c)).toBe('balanced')
    expect(inferTier('opus', c)).toBe('powerful')
    expect(inferTier('haiku', c)).toBe('fast')
    expect(inferTier('Opus', c)).toBe('powerful')
  })
  test('fable is powerful', () => {
    expect(inferTier('claude-fable-5-1', c)).toBe('powerful')
    expect(inferTier('fable', c)).toBe('powerful')
  })
  test('unknown → balanced', () => {
    expect(inferTier('gpt-5', c)).toBe('balanced')
    expect(inferTier('', c)).toBe('balanced')
    expect(inferTier(undefined, c)).toBe('balanced')
    expect(inferTier(42, c)).toBe('balanced')
  })
  test('exact match against a custom map wins over family', () => {
    const c2 = cfg({ model_fast: 'claude-sonnet-5-5', model_balanced: 'claude-opus-5-5', model_powerful: 'claude-opus-5-5[1m]' })
    expect(inferTier('claude-sonnet-5-5', c2)).toBe('fast')
    expect(inferTier('claude-opus-5-5', c2)).toBe('balanced')
    expect(inferTier('claude-opus-5-5[1m]', c2)).toBe('powerful')
  })
  test('family missing from the map ranks against the map', () => {
    const c2 = cfg({ model_fast: 'haiku', model_balanced: 'haiku', model_powerful: 'sonnet' })
    expect(inferTier('claude-opus-5', c2)).toBe('powerful')
    const c3 = cfg({ model_fast: 'sonnet', model_balanced: 'opus', model_powerful: 'opus' })
    expect(inferTier('haiku', c3)).toBe('fast')
  })
})

describe('session model rules', () => {
  const c = cfg()
  test('unknown session model: never rewrite the model, effort still routed', () => {
    const d = settle(ans('fast', 0.95), 'gpt-5')
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe('gpt-5')
    expect(d.tier).toBe('fast')
    expect(d.effort).toBe('low')
    expect(stepPatch(d, c)).toEqual({ effort: 'low' })
    expect(describeSession('gpt-5', c).known).toBe(false)
  })
  test('unknown session model with route_effort off → no rewrite at all', () => {
    const c2 = cfg({ route_effort: false })
    const d = resolveDecision(composeDecision(ans('powerful', 0.95, 0.9), c2, 'jev'), describeSession('gpt-5', c2), c2)
    expect(d.rewrite).toBe(false)
    expect(d.model).toBe('gpt-5')
  })
  test('fable session: never moved off, effort routed', () => {
    const down = settle(ans('fast', 0.99), 'claude-fable-5-1')
    expect(down.rewriteModel).toBe(false)
    expect(down.model).toBe('claude-fable-5-1')
    expect(down.effort).toBe('low')
    const risky = settle(ans('balanced', 0.5, 0.9), 'claude-fable-5-1')
    expect(risky.model).toBe('claude-fable-5-1')
    expect(risky.effort).toBe('max')
    expect(describeSession('claude-fable-5-1', c).tier).toBe('powerful')
  })
  test('same tier keeps the exact session id even when it differs from the map entry', () => {
    const d = settle(ans('balanced', 0.9), 'claude-sonnet-4-6')
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe('claude-sonnet-4-6')
    expect(stepPatch(d, c)).toEqual({ effort: 'medium' })
  })
  test('missing session model (no e.model) is unknown: model untouched', () => {
    const d = resolveDecision(composeDecision(ans('fast', 0.99), c, 'jev'), describeSession(undefined, c), c)
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe(HAIKU) // nothing better to display; never sent as a model patch
    expect(stepPatch(d, c)?.model).toBeUndefined()
  })
})

describe('[1m] long-context carry-over', () => {
  test('a [1m] session appends [1m] to the target model', () => {
    const d = settle(ans('fast', 0.95), 'claude-sonnet-5[1m]')
    expect(d.rewriteModel).toBe(true)
    expect(d.model).toBe(`${HAIKU}[1m]`)
    const up = settle(ans('powerful', 0.95), 'claude-sonnet-5[1m]')
    expect(up.model).toBe(`${OPUS}[1m]`)
  })
  test('no double suffix when the map entry already has it', () => {
    const c2 = cfg({ model_powerful: 'claude-opus-5-5[1m]' })
    const d = resolveDecision(composeDecision(ans('powerful', 0.95), c2, 'jev'), describeSession('claude-sonnet-5[1m]', c2), c2)
    expect(d.model).toBe('claude-opus-5-5[1m]')
  })
  test('a plain session does not add [1m]', () => {
    expect(settle(ans('powerful', 0.95), 'claude-sonnet-5-5').model).toBe(OPUS)
  })
  test('same tier on a [1m] session keeps the id verbatim', () => {
    expect(settle(ans('balanced', 0.95), 'claude-sonnet-5[1m]').model).toBe('claude-sonnet-5[1m]')
  })
})

describe('effort is never sent to the haiku family', () => {
  const c = cfg()
  test('routing down to haiku rewrites the model only', () => {
    const d = settle(ans('fast', 0.95), SONNET)
    expect(d.rewriteModel).toBe(true)
    expect(stepPatch(d, c)).toEqual({ model: HAIKU })
    expect(effortApplies(HAIKU, c)).toBe(false)
    expect(effortApplies('haiku[1m]', c)).toBe(false)
    expect(effortApplies(SONNET, c)).toBe(true)
  })
  test('a haiku session staying on fast has nothing to patch', () => {
    const d = settle(ans('fast', 0.95), HAIKU)
    expect(d.rewrite).toBe(false)
    expect(stepPatch(d, c)).toBeNull()
    expect(decide(ans('fast', 0.95), 'fast', c)).toBeNull()
  })
})

describe('statusText', () => {
  const c = cfg()
  test('off / on / decision / kept', () => {
    expect(statusText(null, false)).toBe('route: off')
    expect(statusText(null, true)).toBe('route: on')
    const d = decide(ans('fast', 0.92), 'balanced', c)!
    expect(statusText(d, true)).toBe(`route: fast ${HAIKU} 0.92`)
    const kept = resolveDecision(composeDecision(ans('fast', 0.2), c, 'jev'), 'balanced', c)
    expect(statusText(kept, true)).toBe(`route: balanced ${SONNET} 0.20 (kept)`)
    const unknown = settle(ans('fast', 0.9), 'gpt-5')
    expect(statusText(unknown, true)).toBe('route: fast gpt-5 0.90 (kept)')
  })
})

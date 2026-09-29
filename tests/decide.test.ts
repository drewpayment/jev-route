import { describe, expect, test } from 'bun:test'
import {
  addUsage,
  anchorModel,
  composeDecision,
  contextLocked,
  contextTokensOf,
  decide,
  describeSession,
  effortApplies,
  family,
  fitsWindow,
  inferTier,
  normalizeModel,
  resolveDecision,
  statusText,
  stepPatch,
  stepUsage,
  supportsLongContext,
  tierEffort,
  usageText,
  type TurnContext,
} from '../hooks/decide.ts'
import type { Answers, Decision } from '../hooks/types.ts'
import { cfg } from './helpers.ts'

const ans = (tier: Answers['tier'], confidence: number, risky: number | null = 0.05): Answers => ({ tier, confidence, risky })

const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

/** Settle answers against a session model id (as turn.step does). */
const settle = (a: Answers, sessionModel: string, c = cfg(), ctx: TurnContext = {}) =>
  resolveDecision(composeDecision(a, c, 'jev'), describeSession(sessionModel, c), c, ctx)

/** A completed main-agent decision that ran on `model` on a `sessionModel` session. */
const lastOn = (model: string, sessionModel: string, c = cfg()): Decision => ({
  ...settle(ans(inferTier(model, c), 1), sessionModel, c),
  model,
  rewriteModel: model !== sessionModel,
  rewrite: model !== sessionModel,
  sessionModel,
})

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
    expect(tierEffort('fast')).toBe('low')
    expect(tierEffort('balanced')).toBe('medium')
    expect(tierEffort('powerful')).toBe('high')
  })
  test('risky never changes effort: it only picks the tier', () => {
    expect(composeDecision(ans('fast', 0.1, 0.9), cfg(), 'jev').effort).toBe('high')
    expect(composeDecision(ans('balanced', 0.1, 0.9), cfg(), 'jev').tier).toBe('powerful')
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
  test('no upgrade below upgrade_confidence: model kept, nothing patched', () => {
    expect(decide(ans('powerful', 0.29), 'balanced', c)).toBeNull()
    const d = resolveDecision(composeDecision(ans('powerful', 0.29), c, 'jev'), 'balanced', c)
    expect(d.rewriteModel).toBe(false)
    expect(d.rewrite).toBe(false)
    expect(d.tier).toBe('balanced')
    expect(d.model).toBe(SONNET)
    expect(stepPatch(d, c)).toBeNull()
  })
  test('downgrade at or above downgrade_confidence', () => {
    expect(decide(ans('fast', 0.6), 'balanced', c)?.tier).toBe('fast')
    expect(decide(ans('balanced', 0.61), 'powerful', c)?.tier).toBe('balanced')
  })
  test('no downgrade below downgrade_confidence', () => {
    expect(decide(ans('fast', 0.59), 'balanced', c)).toBeNull()
    expect(decide(ans('fast', 0.45), 'powerful', c)).toBeNull()
  })
  test('same tier → keep the model, effort untouched (it would invalidate the cache)', () => {
    const kept = resolveDecision(composeDecision(ans('balanced', 1), c, 'jev'), 'balanced', c)
    expect(kept.rewriteModel).toBe(false)
    expect(kept.rewrite).toBe(false)
    expect(kept.tier).toBe('balanced')
    expect(stepPatch(kept, c)).toBeNull()
    expect(decide(ans('balanced', 1), 'balanced', c)).toBeNull()
  })
  test('route_effort off → a move rewrites the model only', () => {
    const c2 = cfg({ route_effort: false })
    expect(decide(ans('balanced', 1), 'balanced', c2)).toBeNull()
    const up = decide(ans('powerful', 0.9), 'balanced', c2)!
    expect(stepPatch(up, c2)).toEqual({ model: OPUS })
  })
  test('custom thresholds', () => {
    const c2 = cfg({ upgrade_confidence: 0.5, downgrade_confidence: 0.9 })
    expect(decide(ans('powerful', 0.45), 'balanced', c2)).toBeNull()
    expect(decide(ans('powerful', 0.5), 'balanced', c2)?.tier).toBe('powerful')
    expect(decide(ans('fast', 0.85), 'balanced', c2)).toBeNull()
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
  test('risky >= 0.7 forces powerful (effort high, the tier effort) regardless of tier/confidence', () => {
    const d = decide(ans('fast', 0.1, 0.7), 'balanced', c)
    expect(d?.tier).toBe('powerful')
    expect(d?.effort).toBe('high')
    expect(d?.model).toBe(OPUS)
    expect(d?.requested).toBe('powerful')
    expect(d?.rewriteModel).toBe(true)
    expect(stepPatch(d!, c)).toEqual({ model: OPUS, effort: 'high' })
  })
  test('risky on an already-powerful session keeps the exact session model and touches nothing', () => {
    const d = settle(ans('powerful', 0.2, 0.95), 'claude-opus-5')
    expect(d.rewrite).toBe(false)
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe('claude-opus-5')
    expect(stepPatch(d, c)).toBeNull()
  })
  test('risky ignores the switch lock (it is an upgrade)', () => {
    const d = settle(ans('fast', 0.1, 0.9), SONNET, c, { contextTokens: 500_000 })
    expect(d.model).toBe(OPUS)
    expect(d.locked).toBe(false)
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
  test('unknown session model: never rewrite anything', () => {
    const d = settle(ans('fast', 0.95), 'gpt-5')
    expect(d.rewriteModel).toBe(false)
    expect(d.rewrite).toBe(false)
    expect(d.model).toBe('gpt-5')
    expect(d.tier).toBe('balanced')
    expect(stepPatch(d, c)).toBeNull()
    expect(describeSession('gpt-5', c).known).toBe(false)
    const risky = resolveDecision(composeDecision(ans('powerful', 0.95, 0.9), c, 'jev'), describeSession('gpt-5', c), c)
    expect(risky.rewrite).toBe(false)
    expect(risky.model).toBe('gpt-5')
  })
  test('fable session: never moved off, nothing patched', () => {
    const down = settle(ans('fast', 0.99), 'claude-fable-5-1')
    expect(down.rewriteModel).toBe(false)
    expect(down.rewrite).toBe(false)
    expect(down.model).toBe('claude-fable-5-1')
    expect(down.tier).toBe('powerful')
    const risky = settle(ans('balanced', 0.5, 0.9), 'claude-fable-5-1')
    expect(risky.model).toBe('claude-fable-5-1')
    expect(stepPatch(risky, c)).toBeNull()
    expect(describeSession('claude-fable-5-1', c).tier).toBe('powerful')
  })
  test('same tier keeps the exact session id even when it differs from the map entry', () => {
    const d = settle(ans('balanced', 0.9), 'claude-sonnet-4-6')
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe('claude-sonnet-4-6')
    expect(stepPatch(d, c)).toBeNull()
  })
  test('a settled decision remembers the session model it was settled against', () => {
    expect(settle(ans('powerful', 0.9), SONNET).sessionModel).toBe(SONNET)
    expect(settle(ans('powerful', 0.9), 'gpt-5').sessionModel).toBe('gpt-5')
  })
  test('missing session model (no e.model) is unknown: model untouched', () => {
    const d = resolveDecision(composeDecision(ans('fast', 0.99), c, 'jev'), describeSession(undefined, c), c)
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe(HAIKU) // nothing better to display; never sent as a model patch
    expect(stepPatch(d, c)?.model).toBeUndefined()
  })
})

describe('[1m] long-context carry-over', () => {
  test('a [1m] session appends [1m] to a target that has a 1M window', () => {
    const up = settle(ans('powerful', 0.95), 'claude-sonnet-5[1m]')
    expect(up.rewriteModel).toBe(true)
    expect(up.model).toBe(`${OPUS}[1m]`)
    expect(supportsLongContext(OPUS)).toBe(true)
    expect(supportsLongContext(HAIKU)).toBe(false)
  })
  test('haiku never gets [1m]; with unknown context a fast route becomes balanced', () => {
    const d = settle(ans('fast', 0.95), 'claude-sonnet-5[1m]')
    expect(d.tier).toBe('balanced')
    expect(d.rewriteModel).toBe(false)
    expect(d.model).toBe('claude-sonnet-5[1m]')
    expect(fitsWindow(HAIKU, true, null)).toBe(false)
  })
  test('haiku is used on a [1m] session only while the context is known to fit', () => {
    const small = settle(ans('fast', 0.95), 'claude-sonnet-5[1m]', cfg(), { contextTokens: 40_000 })
    expect(small.model).toBe(HAIKU)
    expect(small.tier).toBe('fast')
    const big = settle(ans('fast', 0.95), 'claude-sonnet-5[1m]', cfg({ switch_lock_tokens: 0 }), { contextTokens: 160_000 })
    expect(big.tier).toBe('balanced')
    expect(big.model).toBe('claude-sonnet-5[1m]')
    expect(fitsWindow(HAIKU, true, 149_999)).toBe(true)
    expect(fitsWindow(HAIKU, true, 150_000)).toBe(false)
    expect(fitsWindow(HAIKU, false, null)).toBe(true)
  })
  test('a turn anchored on haiku leaves it once the context outgrows the window', () => {
    const c = cfg({ switch_lock_tokens: 0 })
    const last = lastOn(HAIKU, 'claude-sonnet-5[1m]', c)
    const d = settle(ans('fast', 0.1), 'claude-sonnet-5[1m]', c, { last, contextTokens: 190_000 })
    expect(d.tier).toBe('balanced')
    expect(d.model).toBe('claude-sonnet-5[1m]')
    expect(d.rewriteModel).toBe(false)
  })
  test('a powerful map entry without a 1M variant on a [1m] session is left alone (no tier above it)', () => {
    const c = cfg({ model_powerful: 'claude-haiku-4-5' })
    const d = settle(ans('powerful', 0.95), 'claude-sonnet-5[1m]', c)
    expect(d.model).toBe('claude-haiku-4-5')
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

describe('hysteresis anchors on the last routed model', () => {
  const c = cfg()

  test('no last decision → the session model is the anchor', () => {
    const session = describeSession(SONNET, c)
    expect(anchorModel(session, {}, c).model).toBe(SONNET)
    expect(anchorModel(session, { last: null }, c).model).toBe(SONNET)
  })

  test('after an Opus turn on a Sonnet session, a balanced grade must clear the downgrade threshold', () => {
    const last = lastOn(OPUS, SONNET, c)
    expect(anchorModel(describeSession(SONNET, c), { last }, c).tier).toBe('powerful')
    // not confident enough: stay on Opus, which means rewriting to it again
    const stay = settle(ans('balanced', 0.5), SONNET, c, { last })
    expect(stay.tier).toBe('powerful')
    expect(stay.model).toBe(OPUS)
    expect(stay.rewriteModel).toBe(true)
    expect(stepPatch(stay, c)).toEqual({ model: OPUS, effort: 'high' })
    // confident: back to the session model, nothing patched (its effort is Claude Code's own)
    const back = settle(ans('balanced', 0.6), SONNET, c, { last })
    expect(back.tier).toBe('balanced')
    expect(back.model).toBe(SONNET)
    expect(back.rewriteModel).toBe(false)
    expect(stepPatch(back, c)).toBeNull()
  })

  test('after a Haiku turn on a Sonnet session, going back up is an upgrade', () => {
    const last = lastOn(HAIKU, SONNET, c)
    expect(settle(ans('balanced', 0.29), SONNET, c, { last }).model).toBe(HAIKU)
    const up = settle(ans('balanced', 0.3), SONNET, c, { last })
    expect(up.model).toBe(SONNET)
    expect(up.rewriteModel).toBe(false)
    expect(settle(ans('powerful', 0.3), SONNET, c, { last }).model).toBe(OPUS)
  })

  test('a kept last turn anchors on the session model', () => {
    const last = lastOn(SONNET, SONNET, c)
    expect(anchorModel(describeSession(SONNET, c), { last }, c).model).toBe(SONNET)
    expect(settle(ans('fast', 0.6), SONNET, c, { last }).model).toBe(HAIKU)
  })

  test('the anchor is dropped when the user changed the session model since', () => {
    const last = lastOn(OPUS, SONNET, c)
    const session = describeSession('claude-sonnet-4-6', c)
    expect(anchorModel(session, { last }, c).model).toBe('claude-sonnet-4-6')
    const d = settle(ans('balanced', 0.1), 'claude-sonnet-4-6', c, { last })
    expect(d.model).toBe('claude-sonnet-4-6')
    expect(d.rewriteModel).toBe(false)
  })

  test('a subagent last decision never anchors the main agent', () => {
    const last = { ...lastOn(OPUS, SONNET, c), agentId: 'agent-7' }
    expect(anchorModel(describeSession(SONNET, c), { last }, c).model).toBe(SONNET)
  })

  test('an unknown or fable session ignores the anchor', () => {
    const last = lastOn(OPUS, 'gpt-5', c)
    expect(anchorModel(describeSession('gpt-5', c), { last }, c).model).toBe('gpt-5')
    const fable = { ...lastOn(OPUS, 'claude-fable-5-1', c), sessionModel: 'claude-fable-5-1' }
    expect(anchorModel(describeSession('claude-fable-5-1', c), { last: fable }, c).model).toBe('claude-fable-5-1')
  })
})

describe('switch lock by context size', () => {
  const c = cfg() // switch_lock_tokens 50_000

  test('contextLocked', () => {
    expect(contextLocked(null, c)).toBe(false)
    expect(contextLocked(undefined, c)).toBe(false)
    expect(contextLocked(49_999, c)).toBe(false)
    expect(contextLocked(50_000, c)).toBe(true)
    expect(contextLocked(1_000_000, cfg({ switch_lock_tokens: 0 }))).toBe(false)
    expect(contextLocked(10, cfg({ switch_lock_tokens: 5 }))).toBe(true)
  })

  test('downgrades are blocked past the lock and reported as locked', () => {
    const d = settle(ans('fast', 0.99), SONNET, c, { contextTokens: 120_000 })
    expect(d.tier).toBe('balanced')
    expect(d.model).toBe(SONNET)
    expect(d.locked).toBe(true)
    expect(d.rewriteModel).toBe(false)
    expect(stepPatch(d, c)).toBeNull()
  })

  test('downgrades run below the lock or when the context is unknown', () => {
    expect(settle(ans('fast', 0.99), SONNET, c, { contextTokens: 20_000 }).model).toBe(HAIKU)
    expect(settle(ans('fast', 0.99), SONNET, c, {}).model).toBe(HAIKU)
    expect(settle(ans('fast', 0.99), SONNET, c, { contextTokens: 20_000 }).locked).toBe(false)
  })

  test('upgrades are never locked', () => {
    const d = settle(ans('powerful', 0.5), SONNET, c, { contextTokens: 400_000 })
    expect(d.model).toBe(OPUS)
    expect(d.locked).toBe(false)
  })

  test('a locked turn stays on the anchored routed model', () => {
    const last = lastOn(OPUS, SONNET, c)
    const d = settle(ans('balanced', 0.99), SONNET, c, { last, contextTokens: 200_000 })
    expect(d.model).toBe(OPUS)
    expect(d.locked).toBe(true)
    expect(d.rewriteModel).toBe(true)
  })

  test('locked is only set when confidence would otherwise have moved', () => {
    const d = settle(ans('fast', 0.2), SONNET, c, { contextTokens: 200_000 })
    expect(d.locked).toBe(false)
  })
})

describe('usage from turn.step results', () => {
  test('stepUsage reads snake_case and camelCase, ignores junk', () => {
    expect(stepUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } })).toEqual({ input: 10, cacheRead: 100, cacheWrite: 5 })
    expect(stepUsage({ usage: { inputTokens: 10, cacheReadInputTokens: 100 } })).toEqual({ input: 10, cacheRead: 100, cacheWrite: 0 })
    expect(stepUsage({ usage: { input_tokens: -3, cache_read_input_tokens: 'x' } })).toBeNull()
    expect(stepUsage({ usage: {} })).toBeNull()
    expect(stepUsage({ answer: 'ok' })).toBeNull()
    expect(stepUsage(null)).toBeNull()
    expect(stepUsage('text')).toBeNull()
  })
  test('contextTokensOf sums everything the model read', () => {
    expect(contextTokensOf({ input: 10, cacheRead: 100, cacheWrite: 5 })).toBe(115)
  })
  test('addUsage keeps running totals and the last context size', () => {
    const a = addUsage(undefined, { input: 1000, cacheRead: 0, cacheWrite: 9000 })
    expect(a).toEqual({ steps: 1, input: 1000, cacheRead: 0, cacheWrite: 9000, context: 10_000 })
    const b = addUsage(a, { input: 200, cacheRead: 10_000, cacheWrite: 800 })
    expect(b).toEqual({ steps: 2, input: 1200, cacheRead: 10_000, cacheWrite: 9800, context: 11_000 })
    expect(usageText(b)).toBe('ctx 11k, cache read 48% (2 steps)')
    expect(usageText(a)).toBe('ctx 10k, cache read 0% (1 step)')
  })
})

describe('statusText', () => {
  const c = cfg()
  test('off / on / decision / kept / locked', () => {
    expect(statusText(null, false)).toBe('route: off')
    expect(statusText(null, true)).toBe('route: on')
    const d = decide(ans('fast', 0.92), 'balanced', c)!
    expect(statusText(d, true)).toBe(`route: fast ${HAIKU} 0.92`)
    const kept = resolveDecision(composeDecision(ans('fast', 0.2), c, 'jev'), 'balanced', c)
    expect(statusText(kept, true)).toBe(`route: balanced ${SONNET} 0.20 (kept)`)
    const unknown = settle(ans('fast', 0.9), 'gpt-5')
    expect(statusText(unknown, true)).toBe('route: balanced gpt-5 0.90 (kept)')
    const locked = settle(ans('fast', 0.9), SONNET, c, { contextTokens: 90_000 })
    expect(statusText(locked, true)).toBe(`route: balanced ${SONNET} 0.90 (locked)`)
  })
})

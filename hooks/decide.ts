// Decision rules: tier inference, hysteresis, model/effort patch. Pure.

import type { Config } from './config.ts'
import { TIERS, type Answers, type Decision, type Effort, type Source, type Tier } from './types.ts'

export const RISKY_THRESHOLD = 0.7
export const LONG_CONTEXT_SUFFIX = '[1m]'

const RANK: Record<Tier, number> = { fast: 0, balanced: 1, powerful: 2 }

/** Model families, most capable first. `fable` ranks above opus but is never routed to or away from. */
export const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type Family = (typeof FAMILIES)[number]
const FAMILY_RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

export function tierEffort(tier: Tier, risky: number | null): Effort {
  if (risky !== null && risky >= RISKY_THRESHOLD) return 'max'
  switch (tier) {
    case 'fast':
      return 'low'
    case 'balanced':
      return 'medium'
    case 'powerful':
      return 'high'
  }
}

export function hasLongContext(model: string): boolean {
  return model.trim().toLowerCase().endsWith(LONG_CONTEXT_SUFFIX)
}

/** Lower-case id without a trailing `[1m]` or `-YYYYMMDD` date suffix. */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase()
  if (m.endsWith(LONG_CONTEXT_SUFFIX)) m = m.slice(0, -LONG_CONTEXT_SUFFIX.length)
  return m.replace(/-\d{8}$/, '')
}

/** Family of a model id or alias (`haiku`, `claude-sonnet-5`, `claude-opus-5-5[1m]`...), or null. */
export function family(model: string): Family | null {
  const m = normalizeModel(model)
  for (const f of FAMILIES) if (m === f || m.includes(f)) return f
  return null
}

function withLongContext(model: string, longContext: boolean): string {
  if (!longContext || hasLongContext(model)) return model
  return model + LONG_CONTEXT_SUFFIX
}

/** Tier whose map entry equals `model` exactly (raw, then normalized), or null. */
function mapTier(model: string, cfg: Config): Tier | null {
  const raw = model.trim().toLowerCase()
  for (const t of TIERS) if (cfg.models[t].trim().toLowerCase() === raw) return t
  const norm = normalizeModel(model)
  for (const t of TIERS) if (normalizeModel(cfg.models[t]) === norm) return t
  return null
}

/**
 * Which tier is the session currently on? Exact match against the model map
 * first, then family of the map entries, then family rank against the map
 * (fable → powerful), else balanced.
 */
export function inferTier(model: unknown, cfg: Config): Tier {
  if (typeof model !== 'string' || model.trim() === '') return 'balanced'
  const exact = mapTier(model, cfg)
  if (exact) return exact
  const fam = family(model)
  if (!fam) return 'balanced'
  for (const t of TIERS) if (family(cfg.models[t]) === fam) return t
  if (fam === 'fable') return 'powerful'
  const ranks = TIERS.map((t) => family(cfg.models[t]))
    .filter((f): f is Family => f !== null)
    .map((f) => FAMILY_RANK[f])
  if (ranks.length > 0) {
    if (FAMILY_RANK[fam] > Math.max(...ranks)) return 'powerful'
    if (FAMILY_RANK[fam] < Math.min(...ranks)) return 'fast'
  }
  return 'balanced'
}

/** What we know about the model the session is on when a turn starts. */
export interface SessionModel {
  /** The session model id exactly as the engine reported it ('' when unknown). */
  model: string
  tier: Tier
  family: Family | null
  /** false when neither the map nor a family recognises the id: the model is then never rewritten. */
  known: boolean
  longContext: boolean
}

export function describeSession(model: unknown, cfg: Config): SessionModel {
  if (typeof model !== 'string' || model.trim() === '') {
    return { model: '', tier: 'balanced', family: null, known: false, longContext: false }
  }
  const raw = model.trim()
  const fam = family(raw)
  return {
    model: raw,
    tier: inferTier(raw, cfg),
    family: fam,
    known: fam !== null || mapTier(raw, cfg) !== null,
    longContext: hasLongContext(raw),
  }
}

function sessionFromTier(tier: Tier, cfg: Config): SessionModel {
  const model = cfg.models[tier]
  return { model, tier, family: family(model), known: true, longContext: hasLongContext(model) }
}

export interface ComposeExtras {
  turnId?: string
  agentId?: string
  promptKey?: string
  latencyMs?: number
  at?: number
}

/** Turn answers into a preliminary decision (target tier); hysteresis not yet applied. */
export function composeDecision(answers: Answers, cfg: Config, source: Source, extras: ComposeExtras = {}): Decision {
  const risky = answers.risky
  const forced = risky !== null && risky >= RISKY_THRESHOLD
  const tier: Tier = forced ? 'powerful' : answers.tier
  return {
    tier,
    requested: tier,
    effort: tierEffort(tier, risky),
    confidence: answers.confidence,
    risky,
    source,
    model: cfg.models[tier],
    ...extras,
  }
}

/** Does effort get sent for this target model? The haiku family ignores/refuses effort. */
export function effortApplies(model: string, cfg: Config): boolean {
  return cfg.routeEffort && family(model) !== 'haiku'
}

/**
 * Settle a decision against the session model:
 *  - risky ≥ 0.7 always wants powerful
 *  - upgrade when confidence ≥ upgradeConfidence, downgrade when ≥ downgradeConfidence
 *  - same tier as the session (or not confident enough) → keep the session model exactly,
 *    route effort only
 *  - unknown session model or a `fable` session → never change the model, effort only
 *  - a `[1m]` session carries the suffix onto the target model
 *  - no effort is sent when the target family is haiku
 */
export function resolveDecision(decision: Decision, current: Tier | SessionModel, cfg: Config): Decision {
  const session = typeof current === 'string' ? sessionFromTier(current, cfg) : current
  const forced = decision.risky !== null && decision.risky >= RISKY_THRESHOLD
  const requested = decision.requested
  const diff = RANK[requested] - RANK[session.tier]

  let move: boolean
  if (forced) move = true
  else if (diff > 0) move = decision.confidence >= cfg.upgradeConfidence
  else if (diff < 0) move = decision.confidence >= cfg.downgradeConfidence
  else move = false

  const tier = move ? requested : session.tier
  const movable = session.known && session.family !== 'fable'

  let model: string
  let rewriteModel: boolean
  if (tier === session.tier || !movable) {
    model = session.model !== '' ? session.model : cfg.models[tier]
    rewriteModel = false
  } else {
    model = withLongContext(cfg.models[tier], session.longContext)
    rewriteModel = true
  }

  const rewrite = rewriteModel || effortApplies(model, cfg)
  return { ...decision, tier, effort: tierEffort(tier, decision.risky), model, rewrite, rewriteModel }
}

/** The turn.step patch for a settled decision, or null when nothing changes. */
export function stepPatch(d: Decision, cfg: Config): { model?: string; effort?: Effort } | null {
  const patch: { model?: string; effort?: Effort } = {}
  if (d.rewriteModel) patch.model = d.model
  if (effortApplies(d.model, cfg)) patch.effort = d.effort
  return patch.model !== undefined || patch.effort !== undefined ? patch : null
}

/**
 * Full pipeline used by tests: returns the settled Decision when it patches
 * anything (model and/or effort), or null when the request is left untouched.
 */
export function decide(answers: Answers, current: Tier | SessionModel, cfg: Config, source: Source = 'jev'): Decision | null {
  const d = resolveDecision(composeDecision(answers, cfg, source), current, cfg)
  return d.rewrite ? d : null
}

/**
 * Status-line text: `route: <tier> <model> <conf>[ (kept)]` after a decision,
 * `route: on` when routing is enabled with no decision, `route: off` when disabled.
 * `(kept)` means the session model was not changed.
 */
export function statusText(d: Decision | null, enabled: boolean): string {
  if (!enabled) return 'route: off'
  if (!d) return 'route: on'
  const conf = d.confidence.toFixed(2)
  const kept = d.rewrite === false || d.rewriteModel === false ? ' (kept)' : ''
  return `route: ${d.tier} ${d.model} ${conf}${kept}`
}

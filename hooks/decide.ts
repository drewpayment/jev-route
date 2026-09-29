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

/**
 * Effort for a tier. Effort is a property of the model a turn runs on, never of
 * the prompt: a top-level effort change invalidates the messages cache on every
 * model, so `risky` no longer bumps effort (it forces the powerful tier instead).
 */
export function tierEffort(tier: Tier): Effort {
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

/** Context window, in tokens, of models that have no `[1m]` variant. */
export const HAIKU_CONTEXT_TOKENS = 200_000
/**
 * On a `[1m]` session a model without a 1M window is only routed to while the
 * context is comfortably inside its window (leaves room for the turn itself).
 */
export const SHORT_WINDOW_MAX_CONTEXT = 150_000

/** Does `model` have a `[1m]` variant? The haiku family is capped at 200k. */
export function supportsLongContext(model: string): boolean {
  return family(model) !== 'haiku'
}

function withLongContext(model: string, longContext: boolean): string {
  if (!longContext || hasLongContext(model) || !supportsLongContext(model)) return model
  return model + LONG_CONTEXT_SUFFIX
}

/**
 * Can a turn with `contextTokens` of context (null = unknown) run on `model`
 * when the session is a `[1m]` one? Only when the model has a 1M variant, or
 * the context is known to fit in its window.
 */
export function fitsWindow(model: string, longContext: boolean, contextTokens: number | null): boolean {
  if (!longContext || supportsLongContext(model)) return true
  return contextTokens !== null && contextTokens < SHORT_WINDOW_MAX_CONTEXT
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
    effort: tierEffort(tier),
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

/** What the previous turns tell us when a decision is settled. */
export interface TurnContext {
  /**
   * The last completed main-agent decision, when it ran on a routed model
   * (`rewriteModel`) on this same session model. Hysteresis then anchors on
   * that model rather than on the session model, so a routed turn is only left
   * (in either direction) when the thresholds say so.
   */
  last?: Decision | null
  /** Context size in tokens of the previous main-agent request; null when unknown. */
  contextTokens?: number | null
}

/** The model hysteresis is measured against: the last routed model, or the session model. */
export function anchorModel(session: SessionModel, ctx: TurnContext, cfg: Config): SessionModel {
  const last = ctx.last
  if (
    last &&
    last.rewriteModel === true &&
    last.agentId === undefined &&
    typeof last.sessionModel === 'string' &&
    last.sessionModel === session.model &&
    session.known &&
    session.family !== 'fable'
  ) {
    const model = last.model
    return { model, tier: inferTier(model, cfg), family: family(model), known: true, longContext: hasLongContext(model) }
  }
  return session
}

/** Is a downgrade blocked by the size of the context? (`switch_lock_tokens` <= 0 disables the lock.) */
export function contextLocked(contextTokens: number | null | undefined, cfg: Config): boolean {
  if (cfg.switchLockTokens <= 0) return false
  return typeof contextTokens === 'number' && contextTokens >= cfg.switchLockTokens
}

/**
 * Settle a decision against the session model and the previous turn:
 *  - hysteresis is measured against the anchor: the model the previous main-agent
 *    turn was routed to (when the session model is unchanged), else the session model
 *  - risky ≥ 0.7 always wants powerful
 *  - upgrade when confidence ≥ upgradeConfidence
 *  - downgrade when confidence ≥ downgradeConfidence, and only while the context is
 *    smaller than switch_lock_tokens: past that a cold cache write on the cheaper
 *    model costs more than the turn saves, so only `risky` moves the model
 *  - same tier as the anchor (or not confident enough) → keep the anchor model
 *  - unknown session model or a `fable` session → never change the model
 *  - a `[1m]` session carries the suffix onto targets that have a 1M variant; a
 *    target without one (haiku) is only used while the context is known to fit,
 *    otherwise the next tier up is taken
 *  - effort is pinned per model: sent only together with a model rewrite (never
 *    to haiku), so a kept model also keeps the effort of its cached conversation
 */
export function resolveDecision(decision: Decision, current: Tier | SessionModel, cfg: Config, ctx: TurnContext = {}): Decision {
  const session = typeof current === 'string' ? sessionFromTier(current, cfg) : current
  const anchor = anchorModel(session, ctx, cfg)
  const forced = decision.risky !== null && decision.risky >= RISKY_THRESHOLD
  const contextTokens = ctx.contextTokens ?? null
  const movable = session.known && session.family !== 'fable'

  const requested = decision.requested
  const diff = RANK[requested] - RANK[anchor.tier]

  let move: boolean
  let locked = false
  if (forced) move = diff !== 0
  else if (diff > 0) move = decision.confidence >= cfg.upgradeConfidence
  else if (diff < 0) {
    move = decision.confidence >= cfg.downgradeConfidence
    if (move && contextLocked(contextTokens, cfg)) {
      move = false
      locked = true
    }
  } else move = false

  let tier: Tier = move ? requested : anchor.tier
  // A [1m] session cannot run on a model without a 1M window once the context
  // may exceed it: take the next tier up that fits.
  if (movable) {
    while (!fitsWindow(cfg.models[tier], session.longContext, contextTokens) && RANK[tier] < RANK.powerful) {
      tier = TIERS[RANK[tier] + 1]
      move = true
    }
  }

  let model: string
  let rewriteModel: boolean
  if (!movable) {
    model = session.model !== '' ? session.model : cfg.models[tier]
    rewriteModel = false
    tier = session.tier
  } else if (!move) {
    model = anchor.model
    rewriteModel = model !== session.model
  } else if (tier === session.tier) {
    model = session.model
    rewriteModel = false
  } else {
    model = withLongContext(cfg.models[tier], session.longContext)
    rewriteModel = model !== session.model
  }

  return {
    ...decision,
    tier,
    effort: tierEffort(tier),
    model,
    rewrite: rewriteModel,
    rewriteModel,
    locked,
    sessionModel: session.model,
  }
}

/**
 * The turn.step patch for a settled decision, or null when nothing changes.
 * Effort rides along with a model rewrite only: the cache of that model is
 * cold anyway, and every later turn on it sends the same effort.
 */
export function stepPatch(d: Decision, cfg: Config): { model?: string; effort?: Effort } | null {
  if (!d.rewriteModel) return null
  const patch: { model?: string; effort?: Effort } = { model: d.model }
  if (effortApplies(d.model, cfg)) patch.effort = d.effort
  return patch
}

/**
 * Full pipeline used by tests: returns the settled Decision when it patches
 * anything (model and/or effort), or null when the request is left untouched.
 */
export function decide(answers: Answers, current: Tier | SessionModel, cfg: Config, source: Source = 'jev', ctx: TurnContext = {}): Decision | null {
  const d = resolveDecision(composeDecision(answers, cfg, source), current, cfg, ctx)
  return d.rewrite ? d : null
}

/** ` (kept)` when the session model runs the turn, ` (locked)` when a downgrade was blocked by context size. */
export function decisionSuffix(d: Decision): string {
  if (d.locked) return ' (locked)'
  return d.rewrite === false || d.rewriteModel === false ? ' (kept)' : ''
}

/**
 * Status-line text: `route: <tier> <model> <conf>[ (kept)| (locked)]` after a
 * decision, `route: on` when routing is enabled with no decision, `route: off`
 * when disabled. `(kept)` means the session model runs the turn; `(locked)`
 * means a cheaper tier was asked for but the context is past switch_lock_tokens.
 */
export function statusText(d: Decision | null, enabled: boolean): string {
  if (!enabled) return 'route: off'
  if (!d) return 'route: on'
  return `route: ${d.tier} ${d.model} ${d.confidence.toFixed(2)}${decisionSuffix(d)}`
}

/** Token fields of a turn.step result's `usage` (snake_case per the API, camelCase tolerated). */
export interface StepUsage {
  input: number
  cacheRead: number
  cacheWrite: number
}

function usageNumber(u: Record<string, unknown>, snake: string, camel: string): number {
  const v = u[snake] ?? u[camel]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** Read the token counts out of a turn.step result, or null when it carries no usage. */
export function stepUsage(result: unknown): StepUsage | null {
  if (typeof result !== 'object' || result === null) return null
  const usage = (result as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  const s = {
    input: usageNumber(u, 'input_tokens', 'inputTokens'),
    cacheRead: usageNumber(u, 'cache_read_input_tokens', 'cacheReadInputTokens'),
    cacheWrite: usageNumber(u, 'cache_creation_input_tokens', 'cacheCreationInputTokens'),
  }
  return s.input + s.cacheRead + s.cacheWrite > 0 ? s : null
}

/** Context size of the request that produced `u`: everything the model read. */
export function contextTokensOf(u: StepUsage): number {
  return u.input + u.cacheRead + u.cacheWrite
}

/** Running per-turn totals stored on the decision. */
export interface TurnUsage extends StepUsage {
  steps: number
  /** Context size of the last step of the turn. */
  context: number
}

export function addUsage(prev: TurnUsage | undefined, u: StepUsage): TurnUsage {
  return {
    steps: (prev?.steps ?? 0) + 1,
    input: (prev?.input ?? 0) + u.input,
    cacheRead: (prev?.cacheRead ?? 0) + u.cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + u.cacheWrite,
    context: contextTokensOf(u),
  }
}

/** `152k` / `830` style token count for status text. */
export function tokensText(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** One-line cache summary: `ctx 152k, cache read 96% (3 steps)`. */
export function usageText(u: TurnUsage): string {
  const total = u.input + u.cacheRead + u.cacheWrite
  const pct = total > 0 ? Math.round((u.cacheRead / total) * 100) : 0
  return `ctx ${tokensText(u.context)}, cache read ${pct}% (${u.steps} step${u.steps === 1 ? '' : 's'})`
}

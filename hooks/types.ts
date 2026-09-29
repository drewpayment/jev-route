// Shared types for the pure modules. Mirrors types/index.d.ts (the $.state
// contract), which must stay self-contained and therefore repeats `Decision`.

export type Tier = 'fast' | 'balanced' | 'powerful'
export type Effort = 'low' | 'medium' | 'high' | 'max'
export type Source = 'jev' | 'builtin'

export const TIERS: readonly Tier[] = ['fast', 'balanced', 'powerful'] as const

/** What Jev (or the built-in classifier) told us about a prompt. */
export interface Answers {
  tier: Tier
  /** 0..1 confidence in `tier`. */
  confidence: number
  /** 0..1 probability that a careless answer is harmful; null when unknown. */
  risky: number | null
  probabilities?: Partial<Record<Tier, number>>
}

/** A per-turn routing decision. */
export interface Decision {
  /** Tier the turn runs on (after hysteresis: may be the current tier). */
  tier: Tier
  /** Tier Jev asked for, before hysteresis. */
  requested: Tier
  effort: Effort
  confidence: number
  risky: number | null
  source: Source
  /** Model id the turn should use: the map entry for `tier`, or the session model when kept. */
  model: string
  /**
   * true  → patch model and/or effort on every step of the turn
   * false → nothing to patch (session model and effort untouched)
   * undefined → not yet resolved against the session model (no turn.step seen)
   */
  rewrite?: boolean
  /** true when `model` differs from the session model (settled decisions only). */
  rewriteModel?: boolean
  /** Turn this decision is bound to; absent until turn.start binds it. */
  turnId?: string
  /** Agent that ran the turn (undefined = main agent). */
  agentId?: string
  /** First 200 chars of the prompt, used to bind an unbound decision at turn.start. */
  promptKey?: string
  latencyMs?: number
  at?: number
}

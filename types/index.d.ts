// $.state contract for the jev-route plugin. Self-contained on purpose: this
// file is referenced from plugin.json ("types") and read by the engine's
// /plugin-types generator, so it must not import anything.

export type Tier = 'fast' | 'balanced' | 'powerful'
export type Effort = 'low' | 'medium' | 'high' | 'max'
export type Source = 'jev' | 'builtin'

export interface Decision {
  tier: Tier
  requested: Tier
  effort: Effort
  confidence: number
  risky: number | null
  source: Source
  model: string
  rewrite?: boolean
  rewriteModel?: boolean
  turnId?: string
  agentId?: string
  promptKey?: string
  latencyMs?: number
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    'jev-route': {
      /** Decisions for turns in flight, keyed by turnId (bound at turn.start, removed at turn.complete). */
      pending: Record<string, Decision>
      /** Decision composed at prompt.submit whose turnId is not yet known. */
      unbound: Decision | null
      /** Decision of the most recent completed main-agent turn (for /route status and previous_tier). */
      last: Decision | null
    }
  }
}

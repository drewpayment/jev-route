// Exercises hooks/register.ts against a fake `$` and an in-memory 'claude-code'
// (atom/read/update) so the wiring, turn binding and fail-open paths are covered
// without the engine. mock.module must run before register.ts is imported.
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Atom = { key: string; initial: unknown }
const state = new Map<string, unknown>()

mock.module('claude-code', () => ({
  atom: (spec: { plugin: string; key: string }, initial: unknown): Atom => ({ key: `${spec.plugin}.${spec.key}`, initial }),
  read: async (_$: unknown, a: Atom) => (state.has(a.key) ? state.get(a.key) : a.initial),
  update: async (_$: unknown, a: Atom, fn: (prev: unknown) => unknown) => {
    const next = fn(state.has(a.key) ? state.get(a.key) : a.initial)
    state.set(a.key, next)
    return next
  },
}))

const { register } = await import('../hooks/register.ts')

const KEY = 'sk-test-secret-key-1234567890'
const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

type Hook = (...args: any[]) => any
type Calls = { status: unknown[]; toast: string[]; fetch: { url: string; init: any }[]; classify: string[] }

function jevResponse(tier: string, confidence: number, risky = 0.05, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ answers: { tier: { type: 'choice', choice: tier, confidence }, risky: { type: 'noul', noul: risky } } }),
  }
}

function fakeDollar(over: Record<string, any> = {}): { $: any; calls: Calls; store: Map<string, unknown> } {
  const calls: Calls = { status: [], toast: [], fetch: [], classify: [] }
  const store = new Map<string, unknown>()
  const $: any = {
    plugin: { name: 'jev-route' },
    store: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => {
        store.set(k, v)
      },
    },
    http: {
      fetch: async (url: string, init: any) => {
        calls.fetch.push({ url, init })
        return jevResponse('powerful', 0.9)
      },
    },
    model: {
      classify: async (text: string) => {
        calls.classify.push(text)
        return 'fast'
      },
    },
    ui: { status: (t: unknown) => calls.status.push(t), toast: (t: string) => calls.toast.push(t) },
    command: { register: async () => {} },
    clock: {
      sleep: (ms: number, opts?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms)
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        }),
    },
  }
  for (const [k, v] of Object.entries(over)) $[k] = { ...$[k], ...v }
  return { $, calls, store }
}

function load(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, Hook>()
  const on = (event: string, a: any, b?: any) => {
    hooks.set(event, typeof a === 'function' ? a : b)
  }
  register(on as any, options)
  return hooks
}

/** Drive a streaming hook, collecting yielded chunks and the return value. */
async function drain(gen: AsyncGenerator<unknown, unknown, unknown>) {
  const chunks: unknown[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

/** A fake downstream for turn.step that records the patch it received. */
function stepNext() {
  const seen: any[] = []
  const next = async function* (patch: any) {
    seen.push(patch)
    yield { type: 'text', text: 'chunk-1' }
    yield { type: 'text', text: 'chunk-2' }
    return { answer: 'ok', stopReason: 'end_turn' }
  }
  return { next, seen }
}

const passNext = () => {
  const seen: unknown[] = []
  const next = async (e: unknown) => {
    seen.push(e)
    return { forwarded: e }
  }
  return { next, seen }
}

const OPTS = { jev_api_key: KEY, timeout_ms: 50 }

async function submit(hooks: Map<string, Hook>, $: any, e: Record<string, unknown>) {
  const p = passNext()
  const out = await hooks.get('prompt.submit')!($, e, p.next)
  return { out, seen: p.seen }
}

async function step(hooks: Map<string, Hook>, $: any, e: Record<string, unknown>) {
  const s = stepNext()
  const drained = await drain(hooks.get('turn.step')!($, e, s.next))
  return { ...drained, patch: s.seen[0], seen: s.seen }
}

const pending = () => (state.get('jev-route.pending') ?? {}) as Record<string, any>
const unbound = () => state.get('jev-route.unbound') as any
const last = () => state.get('jev-route.last') as any

beforeEach(() => {
  state.clear()
})

describe('prompt.submit', () => {
  test('calls next(e) exactly once with the original event and parks the decision', async () => {
    const hooks = load(OPTS)
    const { $, calls } = fakeDollar()
    const e = { text: 'refactor the whole auth layer', turnId: 't1' }
    const { out, seen } = await submit(hooks, $, e)
    expect(seen).toEqual([e])
    expect(seen[0]).toBe(e)
    expect(out).toEqual({ forwarded: e })
    expect(calls.fetch).toHaveLength(1)
    expect(calls.fetch[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(calls.fetch[0].init.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(pending().t1.requested).toBe('powerful')
    expect(pending().t1.rewrite).toBeUndefined()
    expect(unbound().promptKey).toBe('refactor the whole auth layer')
    // no status line until the decision settles on turn.step
    expect(calls.status).toEqual([])
  })

  test('sends redacted, truncated text to Jev', async () => {
    const hooks = load(OPTS)
    const { $, calls } = fakeDollar()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    await submit(hooks, $, { text: `use ${secret} to push ` + 'x'.repeat(30_000), turnId: 't1' })
    const body = JSON.parse(calls.fetch[0].init.body)
    expect(body.state.prompt).not.toContain(secret)
    expect(body.state.prompt).toContain('[REDACTED]')
    expect(body.state.prompt.length).toBeLessThanOrEqual(20_000)
  })

  test('fail-open on missing key: builtin classifier under the same budget with truncated text', async () => {
    const hooks = load({ timeout_ms: 50 })
    const { $, calls } = fakeDollar()
    const e = { text: 'rename foo to bar ' + 'y'.repeat(30_000), turnId: 't1' }
    const { seen } = await submit(hooks, $, e)
    expect(seen).toEqual([e])
    expect(calls.fetch).toHaveLength(0)
    expect(calls.classify).toHaveLength(1)
    expect(calls.classify[0].length).toBeLessThanOrEqual(20_000)
    expect(pending().t1.source).toBe('builtin')
    expect(pending().t1.requested).toBe('fast')
  })

  test('no key and fallback off: passes through without any call', async () => {
    const hooks = load({ fallback_classifier: false })
    const { $, calls } = fakeDollar()
    const e = { text: 'do the thing', turnId: 't1' }
    const { seen } = await submit(hooks, $, e)
    expect(seen).toEqual([e])
    expect(calls.fetch).toHaveLength(0)
    expect(calls.classify).toHaveLength(0)
    expect(pending()).toEqual({})
  })

  test('fetch that never resolves times out; the request is aborted; next(e) still runs once', async () => {
    const hooks = load(OPTS)
    let aborted = false
    const { $, calls } = fakeDollar({
      http: {
        fetch: (_url: string, init: any) =>
          new Promise(() => {
            init.signal.addEventListener('abort', () => {
              aborted = true
            })
          }),
      },
    })
    const e = { text: 'hang forever please', turnId: 't1' }
    const t0 = Date.now()
    const { seen } = await submit(hooks, $, e)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(seen).toEqual([e])
    expect(aborted).toBe(true)
    expect(pending()).toEqual({})
    expect(unbound()).toBeNull()
    expect(calls.status).toEqual(['route: on'])
    const status = await hooks.get('command.run')!($, { args: 'status' })
    expect(status.text).toContain('timeout after 50ms')
  })

  test('stalled body (json never resolves) is covered by the same deadline', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar({ http: { fetch: async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }) } })
    const e = { text: 'stall the body read', turnId: 't1' }
    const t0 = Date.now()
    const { seen } = await submit(hooks, $, e)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(seen).toEqual([e])
    expect(pending()).toEqual({})
  })

  test.each([
    [401, 'unauthorized'],
    [429, 'rate limited'],
    [529, 'overloaded'],
  ])('HTTP %i → no decision, error shown in status', async (code, text) => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar({ http: { fetch: async () => jevResponse('fast', 1, 0, code) } })
    const e = { text: 'some prompt text', turnId: 't1' }
    const { seen } = await submit(hooks, $, e)
    expect(seen).toEqual([e])
    expect(pending()).toEqual({})
    const status = await hooks.get('command.run')!($, { args: 'status' })
    expect(status.text).toContain(text)
    expect(status.text).not.toContain(KEY)
  })

  test('fetch throwing and malformed JSON both fail open', async () => {
    const hooks = load(OPTS)
    const thrower = fakeDollar({
      http: {
        fetch: async () => {
          throw new Error('network access from plugins is disabled by policy')
        },
      },
    })
    const e = { text: 'some prompt text', turnId: 't1' }
    expect((await submit(hooks, thrower.$, e)).seen).toEqual([e])
    expect(pending()).toEqual({})
    expect((await hooks.get('command.run')!(thrower.$, { args: 'status' })).text).toContain('disabled by policy')

    const garbage = fakeDollar({ http: { fetch: async () => ({ status: 200, ok: true, json: async () => ({ nope: true }) }) } })
    expect((await submit(hooks, garbage.$, e)).seen).toEqual([e])
    expect(pending()).toEqual({})
    expect((await hooks.get('command.run')!(garbage.$, { args: 'status' })).text).toContain('unparseable')

    const broken = fakeDollar({
      http: {
        fetch: async () => ({
          status: 200,
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        }),
      },
    })
    expect((await submit(hooks, broken.$, e)).seen).toEqual([e])
    expect(pending()).toEqual({})
  })

  test('routing disabled: no call, no decision', async () => {
    const hooks = load(OPTS)
    const { $, calls } = fakeDollar()
    await hooks.get('command.run')!($, { args: 'off' })
    const e = { text: 'a prompt while off', turnId: 't1' }
    const { seen } = await submit(hooks, $, e)
    expect(seen).toEqual([e])
    expect(calls.fetch).toHaveLength(0)
    expect(pending()).toEqual({})
  })

  test('short prompts are not graded', async () => {
    const hooks = load(OPTS)
    const { $, calls } = fakeDollar()
    await submit(hooks, $, { text: 'ok', turnId: 't1' })
    expect(calls.fetch).toHaveLength(0)
  })

  test('log_decisions toasts once per decision', async () => {
    const hooks = load({ ...OPTS, log_decisions: true })
    const { $, calls } = fakeDollar()
    await submit(hooks, $, { text: 'toast me a decision', turnId: 't1' })
    expect(calls.toast).toHaveLength(1)
    expect(calls.toast[0]).toContain('powerful')
  })
})

describe('turn.start binding', () => {
  test('binds the unbound decision to the turn whose text matches', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar()
    const text = 'design the new caching layer'
    await submit(hooks, $, { text })
    expect(pending()).toEqual({})
    expect(unbound()).not.toBeNull()
    const p = passNext()
    const e = { text, turnId: 'turn-9' }
    await hooks.get('turn.start')!($, e, p.next)
    expect(p.seen).toEqual([e])
    expect(unbound()).toBeNull()
    expect(pending()['turn-9'].requested).toBe('powerful')
    expect('agentId' in pending()['turn-9']).toBe(false)
    const { patch } = await step(hooks, $, { turnId: 'turn-9', index: 0, model: SONNET })
    expect(patch.model).toBe(OPUS)
  })

  test('records the agentId and ignores turns with different text', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar()
    await submit(hooks, $, { text: 'the real prompt text' })
    await hooks.get('turn.start')!($, { text: 'a subagent brief', turnId: 'sub-1', agentId: 'agent-7' }, passNext().next)
    expect(unbound()).not.toBeNull()
    expect(pending()).toEqual({})
    await hooks.get('turn.start')!($, { text: 'the real prompt text', turnId: 'main-1', agentId: 'agent-main' }, passNext().next)
    expect(pending()['main-1'].agentId).toBe('agent-main')
    expect(unbound()).toBeNull()
  })
})

describe('turn.step', () => {
  async function routed(model = SONNET, opts: Record<string, unknown> = OPTS, e: Record<string, unknown> = {}) {
    const hooks = load(opts)
    const fake = fakeDollar()
    await submit(hooks, fake.$, { text: 'refactor the whole auth layer', turnId: 't1', ...e })
    return { hooks, ...fake, model }
  }

  test('rewrites model and effort on index 0..2 of the same turn, forwards chunks and the result', async () => {
    const { hooks, $, calls } = await routed()
    for (const index of [0, 1, 2]) {
      const { chunks, result, patch, seen } = await step(hooks, $, { turnId: 't1', index, messageCount: 3 + index, model: SONNET })
      expect(seen).toHaveLength(1)
      expect(patch.model).toBe(OPUS)
      expect(patch.effort).toBe('high')
      expect(patch.turnId).toBe('t1')
      expect(patch.index).toBe(index)
      expect(chunks).toEqual([
        { type: 'text', text: 'chunk-1' },
        { type: 'text', text: 'chunk-2' },
      ])
      expect(result).toEqual({ answer: 'ok', stopReason: 'end_turn' })
    }
    // status line set once, when the decision settled
    expect(calls.status).toEqual([`route: powerful ${OPUS} 0.90`])
    expect(pending().t1.rewrite).toBe(true)
  })

  test('no rewrite for another turnId, a different agentId, or a missing turnId', async () => {
    const { hooks, $ } = await routed()
    const other = await step(hooks, $, { turnId: 't2', index: 0, model: SONNET })
    expect(other.patch).toEqual({ turnId: 't2', index: 0, model: SONNET })
    const agent = await step(hooks, $, { turnId: 't1', index: 0, model: SONNET, agentId: 'agent-7' })
    expect(agent.patch.model).toBe(SONNET)
    expect(agent.patch.effort).toBeUndefined()
    const missing = await step(hooks, $, { index: 0, model: SONNET })
    expect(missing.patch).toEqual({ index: 0, model: SONNET })
    expect(missing.result).toEqual({ answer: 'ok', stopReason: 'end_turn' })
    // still unsettled: none of the above touched the decision
    expect(pending().t1.rewrite).toBeUndefined()
  })

  test('never consults unbound', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar()
    await submit(hooks, $, { text: 'unbound decision here' })
    const { patch } = await step(hooks, $, { turnId: 'tX', index: 0, model: SONNET })
    expect(patch).toEqual({ turnId: 'tX', index: 0, model: SONNET })
  })

  test('same tier keeps the session model and routes effort; haiku target gets no effort', async () => {
    const { hooks, $, calls } = await routed()
    const kept = await step(hooks, $, { turnId: 't1', index: 0, model: 'claude-opus-5' })
    expect(kept.patch.model).toBe('claude-opus-5')
    expect(kept.patch.effort).toBe('high')
    expect(calls.status[0]).toBe('route: powerful claude-opus-5 0.90 (kept)')

    state.clear()
    const hooks2 = load(OPTS)
    const fake2 = fakeDollar({ http: { fetch: async () => jevResponse('fast', 0.95) } })
    await submit(hooks2, fake2.$, { text: 'rename this variable', turnId: 't1' })
    const down = await step(hooks2, fake2.$, { turnId: 't1', index: 0, model: `${SONNET}[1m]` })
    expect(down.patch.model).toBe(`${HAIKU}[1m]`)
    expect('effort' in down.patch).toBe(false)
  })

  test('unknown session model: effort only', async () => {
    const { hooks, $ } = await routed()
    const { patch } = await step(hooks, $, { turnId: 't1', index: 0, model: 'mystery-model' })
    expect(patch.model).toBe('mystery-model')
    expect(patch.effort).toBe('high')
  })

  test('route_effort off and same tier: passes through untouched', async () => {
    const { hooks, $ } = await routed(SONNET, { ...OPTS, route_effort: false })
    const { patch } = await step(hooks, $, { turnId: 't1', index: 0, model: OPUS })
    expect(patch).toEqual({ turnId: 't1', index: 0, model: OPUS })
  })

  test('a queued second prompt.submit does not change the running turn', async () => {
    const { hooks, $ } = await routed()
    await step(hooks, $, { turnId: 't1', index: 0, model: SONNET })
    // second prompt graded while t1 is still running (different answer)
    $.http.fetch = async () => jevResponse('fast', 0.99)
    await submit(hooks, $, { text: 'and now a trivial follow-up' })
    expect(unbound().requested).toBe('fast')
    const { patch } = await step(hooks, $, { turnId: 't1', index: 1, model: SONNET })
    expect(patch.model).toBe(OPUS)
    expect(patch.effort).toBe('high')
    expect(pending().t1.requested).toBe('powerful')
  })

  test('/route off mid-turn leaves the in-flight rewrite in place', async () => {
    const { hooks, $, calls } = await routed()
    await step(hooks, $, { turnId: 't1', index: 0, model: SONNET })
    const r = await hooks.get('command.run')!($, { args: 'off' })
    expect(r.text).toContain('OFF')
    expect(calls.status.at(-1)).toBe('route: off')
    const { patch } = await step(hooks, $, { turnId: 't1', index: 1, model: SONNET })
    expect(patch.model).toBe(OPUS)
    expect(pending().t1).toBeDefined()
  })

  test('a throwing read fails open', async () => {
    const { hooks, $ } = await routed()
    const bad = { ...$, store: $.store }
    // state read failing → pass through
    state.set('jev-route.pending', 'corrupt' as any)
    const { patch, result } = await step(hooks, bad, { turnId: 't1', index: 0, model: SONNET })
    expect(patch.model).toBe(SONNET)
    expect(result).toEqual({ answer: 'ok', stopReason: 'end_turn' })
  })
})

describe('turn.complete', () => {
  async function running() {
    const hooks = load(OPTS)
    const fake = fakeDollar()
    await submit(hooks, fake.$, { text: 'refactor the whole auth layer', turnId: 't1' })
    await step(hooks, fake.$, { turnId: 't1', index: 0, model: SONNET })
    return { hooks, ...fake }
  }

  test('moves the matching entry to last and deletes it', async () => {
    const { hooks, $ } = await running()
    const p = passNext()
    const e = { turnId: 't1', answer: 'done' }
    await hooks.get('turn.complete')!($, e, p.next)
    expect(p.seen).toEqual([e])
    expect(pending()).toEqual({})
    expect(last().tier).toBe('powerful')
    expect(last().rewrite).toBe(true)
  })

  test('a subagent turn.complete mid-turn does not clear the main decision', async () => {
    const { hooks, $ } = await running()
    await hooks.get('turn.complete')!($, { turnId: 'sub-1', agentId: 'agent-7' }, passNext().next)
    expect(pending().t1).toBeDefined()
    expect(last()).toBeUndefined()
    // even a subagent completion that reuses the main turnId is ignored
    await hooks.get('turn.complete')!($, { turnId: 't1', agentId: 'agent-7' }, passNext().next)
    expect(pending().t1).toBeDefined()
    const { patch } = await step(hooks, $, { turnId: 't1', index: 1, model: SONNET })
    expect(patch.model).toBe(OPUS)
  })

  test('main-agent completion of an unrouted turn resets last to null', async () => {
    const { hooks, $ } = await running()
    await hooks.get('turn.complete')!($, { turnId: 't1' }, passNext().next)
    expect(last().tier).toBe('powerful')
    await hooks.get('turn.complete')!($, { turnId: 't2' }, passNext().next)
    expect(last()).toBeNull()
  })

  test('previous_tier follows last', async () => {
    const { hooks, $, calls } = await running()
    await hooks.get('turn.complete')!($, { turnId: 't1' }, passNext().next)
    await submit(hooks, $, { text: 'now fix the tests', turnId: 't2' })
    expect(JSON.parse(calls.fetch[1].init.body).state.previous_tier).toBe('powerful')
    await hooks.get('turn.complete')!($, { turnId: 't2', agentId: 'agent-7' }, passNext().next)
    expect(pending().t2).toBeDefined()
    await hooks.get('turn.complete')!($, { turnId: 't2' }, passNext().next)
    expect(pending()).toEqual({})
  })
})

describe('command.run /route', () => {
  test('on / off / toggle persist in the store and set the status line', async () => {
    const hooks = load(OPTS)
    const { $, calls, store } = fakeDollar()
    const run = (args: string) => hooks.get('command.run')!($, { command: 'route', args })
    expect((await run('off')).text).toContain('routing OFF')
    expect(store.get('enabled')).toBe(false)
    expect(calls.status.at(-1)).toBe('route: off')
    expect((await run('on')).text).toContain('routing ON')
    expect(store.get('enabled')).toBe(true)
    expect(calls.status.at(-1)).toBe('route: on')
    expect((await run('')).text).toContain('routing OFF')
    expect((await run('toggle')).text).toContain('routing ON')
    expect((await run('ON')).text).toContain('Jev via typesafe (https://api.typesafe.ai)')
  })

  test('status never prints the key, redacts URL userinfo and shows configError', async () => {
    const hooks = load({ ...OPTS, jev_base_url: 'https://alice:s3cret@proxy.example.com' })
    const { $ } = fakeDollar()
    const { text } = await hooks.get('command.run')!($, { args: 'status' })
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('s3cret')
    expect(text).toContain('https://[REDACTED]@proxy.example.com')
    expect(text).toContain('API key:      present')
    expect(text).toContain(`fast=${HAIKU}`)
    expect(text).toContain('(no decision yet)')

    const bad = load({ ...OPTS, jev_base_url: 'http://bob:pw@proxy.example.com' })
    const s2 = (await bad.get('command.run')!($, { args: 'status' })).text
    expect(s2).toContain('config error:')
    expect(s2).toContain('only https')
    expect(s2).not.toContain('pw@')
    expect(s2).toContain('source:       builtin')
  })

  test('status shows the last decision', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar()
    await submit(hooks, $, { text: 'refactor the whole auth layer', turnId: 't1' })
    await step(hooks, $, { turnId: 't1', index: 0, model: SONNET })
    await hooks.get('turn.complete')!($, { turnId: 't1' }, passNext().next)
    const { text } = await hooks.get('command.run')!($, { args: 'status' })
    expect(text).toContain(`last:         powerful  model=${OPUS}  conf=0.90`)
    expect(text).not.toContain(KEY)
  })

  test('setup and unknown arguments', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar()
    const setup = (await hooks.get('command.run')!($, { args: 'setup' })).text
    expect(setup).toContain('/plugin configure jev-route')
    expect(setup).toContain('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1')
    expect(setup).not.toContain(KEY)
    const unknown = (await hooks.get('command.run')!($, { args: 'bogus arg' })).text
    expect(unknown).toContain('Unknown argument "bogus"')
    expect(unknown).toContain('Usage: /route [on|off|status|setup]')
  })
})

describe('session.start', () => {
  test('registers the command, sets the status line and calls next', async () => {
    const hooks = load(OPTS)
    const registered: unknown[] = []
    const { $, calls } = fakeDollar({ command: { register: async (spec: unknown) => registered.push(spec) } })
    const p = passNext()
    await hooks.get('session.start')!($, { reason: 'load' }, p.next)
    expect(registered).toEqual([{ name: 'route', description: 'Toggle Jev model routing', argumentHint: '[on|off|status|setup]' }])
    expect(calls.status).toEqual(['route: on'])
    expect(p.seen).toHaveLength(1)
  })

  test('no timer at all: routing is skipped rather than unbounded', async () => {
    const hooks = load(OPTS)
    const { $, calls } = fakeDollar()
    delete $.clock
    const realSetTimeout = globalThis.setTimeout
    // @ts-expect-error simulate a module environment without host timers
    globalThis.setTimeout = undefined
    try {
      const e = { text: 'no timers anywhere', turnId: 't1' }
      const { seen } = await submit(hooks, $, e)
      expect(seen).toEqual([e])
      expect(calls.fetch).toHaveLength(0)
      expect(pending()).toEqual({})
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    const { text } = await hooks.get('command.run')!($, { args: 'status' })
    expect(text).toContain('no timer available')
  })

  test('falls back to the host timer when the engine clock is missing', async () => {
    const hooks = load(OPTS)
    const { $ } = fakeDollar()
    delete $.clock
    const e = { text: 'host timer fallback', turnId: 't1' }
    await submit(hooks, $, e)
    expect(pending().t1.requested).toBe('powerful')
    $.http.fetch = () => new Promise(() => {})
    const t0 = Date.now()
    await submit(hooks, $, { text: 'hang with host timer', turnId: 't2' })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(pending().t2).toBeUndefined()
  })
})

describe('API key fallback from settings env', () => {
  test('uses settings env JEV_API_KEY when userConfig has no key, and status names the source', async () => {
    const hooks = load({ provider: 'gateway', timeout_ms: 50 })
    const { $, calls } = fakeDollar({ settings: { read: async () => ({ env: { JEV_API_KEY: 'vck_fromsettings123' } }) } })
    const { text } = await hooks.get('command.run')!($, { args: 'status' })
    expect(text).toContain('present (19 chars, from settings env JEV_API_KEY)')
    expect(text).not.toContain('vck_fromsettings123')
    await submit(hooks, $, { text: 'design a distributed cache invalidation scheme', turnId: 't1' })
    expect(calls.fetch.length).toBe(1)
    expect(calls.fetch[0].init.headers.authorization).toBe('Bearer vck_fromsettings123')
  })
  test('userConfig key wins over settings env', async () => {
    const hooks = load({ provider: 'gateway', jev_api_key: 'vck_userconfig', timeout_ms: 50 })
    const { $, calls } = fakeDollar({ settings: { read: async () => ({ env: { JEV_API_KEY: 'vck_settings' } }) } })
    await submit(hooks, $, { text: 'design a distributed cache invalidation scheme', turnId: 't1' })
    expect(calls.fetch[0].init.headers.authorization).toBe('Bearer vck_userconfig')
  })
  test('no key anywhere and settings.read throwing: builtin fallback, status says missing', async () => {
    const hooks = load({ provider: 'gateway', timeout_ms: 50 })
    const { $, calls } = fakeDollar({ settings: { read: async () => { throw new Error('nope') } } })
    const { text } = await hooks.get('command.run')!($, { args: 'status' })
    expect(text).toContain('missing (userConfig jev_api_key, or settings env')
    await submit(hooks, $, { text: 'design a distributed cache invalidation scheme', turnId: 't1' })
    expect(calls.fetch.length).toBe(0)
    expect(calls.classify.length).toBe(1)
  })
})

describe('$.http.fetch result shapes', () => {
  const body = JSON.stringify({ answers: { tier: { type: 'choice', choice: 'powerful', confidence: 0.9 }, risky: { type: 'noul', noul: 0.1 } } })
  const shapes: Record<string, unknown> = {
    'engine: text as string': { status: 200, ok: true, text: body },
    'engine: body as string': { status: 200, body },
    'engine: json as object': { status: 200, json: JSON.parse(body) },
    'Response-like: json()': { status: 200, ok: true, json: async () => JSON.parse(body) },
    'Response-like: text()': { status: 200, text: async () => body },
  }
  for (const [name, res] of Object.entries(shapes)) {
    test(name, async () => {
      const hooks = load({ ...OPTS, provider: 'gateway' })
      const { $ } = fakeDollar({ http: { fetch: async () => res } })
      await submit(hooks, $, { text: 'design a distributed cache invalidation scheme', turnId: 't1' })
      expect(unbound()?.tier).toBe('powerful')
    })
  }
  test('no readable body fails open with an error message', async () => {
    const hooks = load({ ...OPTS, provider: 'gateway' })
    const { $, calls } = fakeDollar({ http: { fetch: async () => ({ status: 200 }) } })
    await submit(hooks, $, { text: 'design a distributed cache invalidation scheme', turnId: 't1' })
    expect(unbound()).toBeFalsy()
    const { text } = await hooks.get('command.run')!($, { args: 'status' })
    expect(text).toContain('no readable body')
    expect(calls.classify.length).toBe(0)
  })
})

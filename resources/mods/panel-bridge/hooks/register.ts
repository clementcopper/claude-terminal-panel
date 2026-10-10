/**
 * panel-bridge — the second producer of the Claude Terminal Panel's status row.
 *
 * Claude Code runs the statusLine command only on session state changes, in practice at turn
 * end, so inside a turn the context ring stands still while every tool round trip grows the
 * window. This mod runs inside the Claude process, sees each model request (`turn.step`), each
 * tool call, permission requests, compactions, rate limits and cost, and writes them next to the
 * producer's file as `<tab id>.live.json`. The extension's watcher merges the two; nothing is
 * drawn in the terminal.
 *
 * The contract with the extension is the two environment variables the PTY carries
 * (`CLAUDE_PANEL_STATUS_DIR`, `CLAUDE_PANEL_TAB_ID`) and the JSON shape in `payload()`, documented
 * in README.local.md § Status line. Every field there is optional for the reader.
 */
import type { AgentInfo, AgentStatus, Register, SessionRateLimit, SessionUsage, Timer } from 'claude-code'

const LIVE_SUFFIX = '.live.json'
/** One write per burst: a tool round trip raises several events within milliseconds. */
const WRITE_DELAY_MS = 100
/** The webview cuts at the panel's width; this only bounds the file. */
const SUMMARY_MAX = 200
/** The producer's rule for a tab id that may join a path. */
const TAB_ID = /^[\w.-]+$/

type State = 'idle' | 'busy' | 'asking'

type ToolEntry = { name: string; summary: string; agentId?: string }

/**
 * Everything the file is built from. Module state, not `$.state`: nothing draws from it, and a
 * hot reload (which empties it) is a development case the next event repairs.
 */
const S = {
  path: undefined as string | undefined,
  timer: undefined as Timer | undefined,
  resetAt: 0,
  cwd: undefined as string | undefined,
  window: 0,
  used: undefined as number | undefined,
  stepIndex: undefined as number | undefined,
  modelId: undefined as string | undefined,
  effort: undefined as string | undefined,
  state: 'idle' as State,
  stateAt: 0,
  tools: new Map<string, ToolEntry>(),
  agents: new Set<string>(),
  compacted: 0,
  compactAuto: 0,
  sessionPercent: undefined as number | undefined,
  sessionResetsAt: undefined as number | undefined,
  weekPercent: undefined as number | undefined,
  weekResetsEpoch: undefined as number | undefined,
  costUsd: undefined as number | undefined
}

// ---------- helpers ----------

const now = () => Date.now()

const setState = (state: State) => {
  if (S.state === state) return
  S.state = state
  S.stateAt = now()
}

/** The producer's arithmetic: one decimal, so a 1M window moves in 1k steps rather than 10k. */
const percent = (used: number, total: number) =>
  total > 0 ? Math.round((used / total) * 1000) / 10 : 0

/** What a tool call is about, in a few words, from its arguments. */
const summarize = (e: Record<string, unknown>): string => {
  const str = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : undefined)
  const text =
    str('description') ??
    str('command') ??
    str('file_path') ??
    str('pattern') ??
    str('query') ??
    str('url') ??
    str('skill') ??
    str('prompt') ??
    ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1)}…` : one
}

const epochSeconds = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined
}

const takeLimits = (limits: readonly SessionRateLimit[]) => {
  for (const limit of limits) {
    if (limit.kind === 'five_hour') {
      S.sessionPercent = limit.percentUsed
      S.sessionResetsAt = epochSeconds(limit.resetsAt)
    } else if (limit.kind === 'seven_day') {
      S.weekPercent = limit.percentUsed
      S.weekResetsEpoch = epochSeconds(limit.resetsAt)
    }
  }
}

const takeUsage = (usage: SessionUsage) => {
  if (usage.context.window > 0) S.window = usage.context.window
  if (usage.context.tokens !== undefined) S.used = usage.context.tokens
  takeLimits(usage.rateLimits)
  if (usage.cost) S.costUsd = usage.cost.usd
}

/** The main-thread tool that started last, the one the row names. */
const currentTool = (): { name: string; summary: string } | undefined => {
  let last: ToolEntry | undefined
  for (const entry of S.tools.values()) {
    if (entry.agentId === undefined) last = entry
  }
  return last ? { name: last.name, summary: last.summary } : undefined
}

const payload = () => ({
  v: 1,
  updatedAt: now(),
  resetAt: S.resetAt,
  cwd: S.cwd,
  usedTokens: S.used,
  totalTokens: S.used === undefined ? undefined : S.window,
  usedPercent: S.used === undefined ? undefined : percent(S.used, S.window),
  stepIndex: S.stepIndex,
  modelId: S.modelId,
  effort: S.effort,
  state: S.state,
  stateAt: S.stateAt,
  tool: currentTool(),
  agents: S.agents.size,
  compacted: S.compacted,
  compactAuto: S.compactAuto,
  sessionPercent: S.sessionPercent,
  sessionResetsAt: S.sessionResetsAt,
  weekPercent: S.weekPercent,
  weekResetsEpoch: S.weekResetsEpoch,
  costUsd: S.costUsd
})

const text = () => JSON.stringify(payload())

/**
 * Arms one trailing write; a burst of events lands as one file. The engine interface is never
 * stored or passed on (the loader refuses that), so each call site hands in the two calls it
 * needs as lambdas spelled on its own `$`.
 */
const bump = (after: (fn: () => void) => Timer, write: () => Promise<void>) => {
  if (S.path === undefined || S.timer) return
  S.timer = after(() => {
    S.timer = undefined
    write().catch(() => {
      // The row is a convenience; a failed write must never reach the chain
    })
  })
}

/** Drops the main thread's tools; a subagent's stay with it. */
const clearMainTools = () => {
  for (const [id, entry] of S.tools) {
    if (entry.agentId === undefined) S.tools.delete(id)
  }
}

/** An agent the engine still runs, or holds on its own background work. */
const ACTIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['pending', 'running', 'waiting'])

/**
 * A background agent outlives the turn that spawned it, so the main turn's end keeps the ones
 * the engine still runs; each leaves at its own `turn.complete`. An agent that ended without one
 * leaves here, at the next main turn end. Without an answer from the engine, all go, as before.
 */
const keepRunningAgents = async (list: () => Promise<readonly AgentInfo[]>) => {
  if (S.agents.size === 0) return
  let running: Set<string>
  try {
    running = new Set((await list()).filter((a) => ACTIVE.has(a.status)).map((a) => a.id))
  } catch {
    running = new Set()
  }
  for (const id of S.agents) {
    if (!running.has(id)) S.agents.delete(id)
  }
  for (const [id, entry] of S.tools) {
    if (entry.agentId !== undefined && !S.agents.has(entry.agentId)) S.tools.delete(id)
  }
}

const resetForClear = () => {
  S.resetAt = now()
  S.used = undefined
  S.stepIndex = undefined
  S.compacted = 0
  S.compactAuto = 0
  S.costUsd = 0
  S.tools.clear()
  S.agents.clear()
  S.state = 'idle'
  S.stateAt = S.resetAt
}

// ---------- the module ----------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const dir = await $.env.get('CLAUDE_PANEL_STATUS_DIR')
    const tab = await $.env.get('CLAUDE_PANEL_TAB_ID')
    if (!dir || !tab || !TAB_ID.test(tab)) {
      // Not a panel tab: the mod stays silent
      return next(e)
    }
    S.path = `${dir}/${tab}${LIVE_SUFFIX}`

    // A nested `claude` started from a Bash tool inherits the PTY environment, tab id
    // included, and would load this mod too and overwrite the tab's file with its own
    // state. Children get the variable without this folder; any other folder stays.
    try {
      const dirs = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? ''
      const kept = dirs.split(/[:;]/).filter((d) => d.length > 0 && d !== $.plugin.root)
      await $.env.set('CLAUDE_CODE_PLUGIN_DIRS', kept.length > 0 ? kept.join(':') : undefined)
    } catch {
      // Older engine without env.set: the nested case stays as it is
    }

    S.cwd = e.cwd
    try {
      takeUsage(await $.session.usage())
    } catch {
      // No figures yet; the first measurement brings them
    }
    S.state = 'idle'
    S.stateAt = now()
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Background agents from an earlier turn keep running; only the main thread starts over
    clearMainTools()
    setState('busy')
    try {
      const usage = await $.session.usage()
      if (usage.context.window > 0) S.window = usage.context.window
    } catch {
      // keep the last window
    }
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) {
      yield chunk
    }
    const result = await stream.result
    if (e.agentId === undefined && result.usage) {
      const u = result.usage
      S.used = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      S.stepIndex = e.index
      S.modelId = e.model
      S.effort = e.effort === undefined ? undefined : String(e.effort)
      bump(
        (fn) => $.clock.after(WRITE_DELAY_MS, fn),
        () => $.fs.write(S.path ?? '', text())
      )
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `${e.tool}:${String(now())}`
    S.tools.set(id, {
      name: String(e.tool),
      summary: summarize(e as unknown as Record<string, unknown>),
      agentId: e.agentId
    })
    const asks = e.agentId === undefined && String(e.tool) === 'AskUserQuestion'
    if (asks) setState('asking')
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    try {
      return await next(e)
    } finally {
      S.tools.delete(id)
      if (S.state === 'asking' && e.agentId === undefined) setState('busy')
      bump(
        (fn) => $.clock.after(WRITE_DELAY_MS, fn),
        () => $.fs.write(S.path ?? '', text())
      )
    }
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    setState('asking')
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', ($, e, next) => {
    if (e.notification_type === 'permission_prompt') setState('asking')
    else if (e.notification_type === 'idle_prompt') setState('idle')
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      S.agents.add(spawned.agentId)
      bump(
        (fn) => $.clock.after(WRITE_DELAY_MS, fn),
        () => $.fs.write(S.path ?? '', text())
      )
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      S.agents.delete(e.agentId)
      for (const [id, entry] of S.tools) {
        if (entry.agentId === e.agentId) S.tools.delete(id)
      }
      bump(
        (fn) => $.clock.after(WRITE_DELAY_MS, fn),
        () => $.fs.write(S.path ?? '', text())
      )
      return next(e)
    }
    clearMainTools()
    await keepRunningAgents(() => $.agent.list())
    setState('idle')
    try {
      takeUsage(await $.session.usage())
    } catch {
      // the measurement that follows the turn brings the figures
    }
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    if (e.context.window > 0) S.window = e.context.window
    if (e.context.tokens !== undefined) S.used = e.context.tokens
    takeLimits(e.rateLimits)
    if (e.cost) S.costUsd = e.cost.usd
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && done.skip === undefined) {
      S.compacted += 1
      if (e.trigger === 'auto') S.compactAuto += 1
      if (done.tokensAfter !== undefined) S.used = done.tokensAfter
      bump(
        (fn) => $.clock.after(WRITE_DELAY_MS, fn),
        () => $.fs.write(S.path ?? '', text())
      )
    }
    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      resetForClear()
    } else {
      setState('idle')
      S.tools.clear()
      S.agents.clear()
    }
    // The session is going; a trailing timer would not get to run
    S.timer?.cancel()
    S.timer = undefined
    if (S.path !== undefined) {
      try {
        await $.fs.write(S.path, text())
      } catch {
        // nothing left to tell
      }
    }
    return next(e)
  })
}

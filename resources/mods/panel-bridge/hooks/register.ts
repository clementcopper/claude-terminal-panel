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
import type {
  AgentInfo,
  AgentStatus,
  Register,
  SessionRateLimit,
  SessionUsage,
  Timer
} from 'claude-code'

const LIVE_SUFFIX = '.live.json'
/** One write per burst: a tool round trip raises several events within milliseconds. */
const WRITE_DELAY_MS = 100
/** The webview cuts at the panel's width; this only bounds the file. */
const SUMMARY_MAX = 200
/** The bar cuts at the panel's width and the tooltip shows the rest; this only bounds the file. */
const PROMPT_MAX = 2000
/**
 * The line above the person's prompt in the panel's bar: what Claude's answer before it was about
 * and where the work stood. One Haiku call per main-thread turn end, through the session's own
 * client; measured 2026-11-07 on three real answers: 1.5–2.7 s, 104–586 input tokens.
 */
const SUMMARY_MODEL = 'haiku'
/** The answer is cut here before it goes to Haiku; a long answer's opening carries its topic. */
const SUMMARY_INPUT_MAX = 6000
const SUMMARY_SYSTEM =
  'You label a coding session for a status bar so its owner sees at a glance what it is about and where the work stands. One line, at most 12 words, in the language of the text. Name the topic and the current state or the open question. No subject like "The assistant", no quotes, no preamble.'
/** Bounds the line in the file; the bar cuts at the panel's width. */
const BEFORE_MAX = 200
/** What `/color` takes; the extension's `SESSION_COLORS`. Anything else is not run. */
const COLORS = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'])
/** The producer's rule for a tab id that may join a path. */
const TAB_ID = /^[\w.-]+$/

type State = 'idle' | 'busy' | 'asking'

type ToolEntry = { name: string; summary: string; agentId?: string; startedAt: number }

/**
 * A Bash call for the panel's process monitor. Claude Code writes its output to
 * `<tmp>/claude-<uid>/<project>/<session id>/tasks/<task id>.output` (measured with 2.1.323); the
 * panel reads that file. A background call names its task id in its result; a foreground one
 * never does, so the panel matches it by start time.
 */
type ShellEntry = {
  command: string
  description?: string
  startedAt: number
  sessionId?: string
  background: boolean
  taskId?: string
}

/** Background calls outlive their turn; the panel drops finished ones, this bounds the rest. */
const SHELLS_MAX = 20

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
  /** Bash calls by tool use id: foreground ones while they run, background ones until bounded out. */
  shells: new Map<string, ShellEntry>(),
  agents: new Set<string>(),
  compacted: 0,
  compactAuto: 0,
  sessionPercent: undefined as number | undefined,
  sessionResetsAt: undefined as number | undefined,
  weekPercent: undefined as number | undefined,
  weekResetsEpoch: undefined as number | undefined,
  costUsd: undefined as number | undefined,
  /**
   * What the person typed for the turn about to start, when its text is markup: a slash command
   * (`<command-message>…`) or a `!` line (the turn opens on `<bash-stdout>…`). `turn.start` takes it.
   */
  typed: undefined as string | undefined,
  /** The person's last prompt, one line, and when it was sent. Kept across turns. */
  prompt: undefined as string | undefined,
  promptAt: undefined as number | undefined,
  /** The `/color` this tab runs; the panel tints the prompt bar with it. */
  color: undefined as string | undefined,
  /** Whether `/color` ran in this session, by the mod or by the person. */
  colorApplied: false,
  /** Real prompts so far, so a late summary knows whether it still belongs to the newest one. */
  prompts: 0,
  /** The line for the newest main-thread answer, once Haiku has written it. */
  lastSummary: undefined as string | undefined,
  /** The line shown above `prompt`: the answer the person was replying to. */
  before: undefined as string | undefined,
  /** Cancels a summary still running when the next answer is in. */
  summaryAbort: undefined as AbortController | undefined
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

/** One line, bounded: Haiku sometimes adds a newline or a trailing period run. */
const oneLine = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > BEFORE_MAX ? `${one.slice(0, BEFORE_MAX - 1)}…` : one
}

/** Without Haiku: the answer's first non-empty line, so the bar still says something. */
const fallbackLine = (answer: string): string =>
  oneLine(answer.split('\n').find((line) => line.trim().length > 0) ?? '')

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
const currentTool = (): { name: string; summary: string; startedAt: number } | undefined => {
  let last: ToolEntry | undefined
  for (const entry of S.tools.values()) {
    if (entry.agentId === undefined) last = entry
  }
  return last ? { name: last.name, summary: last.summary, startedAt: last.startedAt } : undefined
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
  costUsd: S.costUsd,
  prompt: S.prompt,
  promptAt: S.promptAt,
  before: S.before,
  color: S.color,
  shells: [...S.shells].map(([key, shell]) => ({ key, ...shell }))
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
  // A new conversation: the old prompt would name work that is gone
  S.prompt = undefined
  S.promptAt = undefined
  S.typed = undefined
  S.lastSummary = undefined
  S.before = undefined
  S.summaryAbort?.abort()
  S.tools.clear()
  // Background calls keep running across a /clear and keep their session's folder
  for (const [key, shell] of S.shells) {
    if (!shell.background) S.shells.delete(key)
  }
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

    // The tab's prompt-bar colour, picked by the extension so parallel tabs differ. The panel's bar
    // takes it now; `/color` itself waits for the first real prompt (see `turn.start`): run here,
    // it wrote a transcript for every tab that never got a prompt, and `--continue` then reopened
    // that empty session instead of the last real one (2026-11-08, reproduced).
    // Cleared for children like the plugin folder, or a nested `claude` would recolour itself.
    try {
      const color = await $.env.get('CLAUDE_PANEL_COLOR')
      if (color && COLORS.has(color)) {
        S.color = color
      }
      await $.env.set('CLAUDE_PANEL_COLOR', undefined)
    } catch {
      // Older engine without command.run or env.set: no colour, nothing else changes
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
    // The panel's bar above the terminal shows it. A continuation carries no text, and a turn the
    // engine starts itself (a background task's notification) carries markup, not the person's
    // words; both keep the last prompt. A slash command or a `!` line arrives as markup too, so it
    // comes as typed from `prompt.submit` / `session.append`.
    const typed = e.agentId === undefined ? S.typed : undefined
    if (e.agentId === undefined) S.typed = undefined
    const said = (typed ?? e.text).replace(/\s+/g, ' ').trim()
    if (said.length > 0 && (typed !== undefined || !said.startsWith('<'))) {
      S.prompt = said.length > PROMPT_MAX ? `${said.slice(0, PROMPT_MAX - 1)}…` : said
      S.promptAt = now()
      S.prompts += 1
      // The answer this prompt replies to; a summary still on its way sets it when it lands
      S.before = S.lastSummary
      // The session has a transcript now, so `/color` adds to it instead of creating one. From a
      // timer, not from this hook: a command run inside a hook the turn waits on is refused; it
      // queues and runs once the turn is over, so Claude's frame turns after the first answer.
      if (S.color !== undefined && !S.colorApplied) {
        S.colorApplied = true
        const color = S.color
        $.clock.after(WRITE_DELAY_MS, () => {
          $.command.run({ command: 'color', args: color }).catch(() => {
            // An engine without /color or command.run: the bar keeps its default
          })
        })
      }
    }
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

  // The prompt as typed: a skill or prompt command shows as `/code-review high`, not as the engine's
  // `<command-message>` markup. Only the person's own (the terminal, or the phone through Remote
  // Control); a local command such as `/context` raises no `prompt.submit` and keeps the topic.
  // `next(e)` resolves after `turn.start`, so the text is set before it.
  on('prompt.submit', async ($, e, next) => {
    if (
      S.path !== undefined &&
      !e.isMeta &&
      (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    ) {
      S.typed = e.text
    }
    const entered = await next(e)
    if (entered.drop !== undefined) S.typed = undefined
    return entered
  }).catch(($, e, next) => next(e))

  // A `!` line raises no `prompt.submit`; the engine records it as `<bash-input>…` and then starts a
  // turn on its output (2.1.319, measured 2026-11-09), which `turn.start` names with this.
  on('session.append', ($, e, next) => {
    if (
      S.path !== undefined &&
      e.agentId === undefined &&
      e.door === 'command' &&
      e.message.type === 'user'
    ) {
      const first = e.message.content[0]
      const text = first?.type === 'text' && typeof first.text === 'string' ? first.text : ''
      const line = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)
      if (line) S.typed = `!${line[1] ?? ''}`
    }
    return next(e)
  }).catch(($, e, next) => next(e))

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
      agentId: e.agentId,
      startedAt: now()
    })
    const asks = e.agentId === undefined && String(e.tool) === 'AskUserQuestion'
    if (asks) setState('asking')
    const bash = String(e.tool) === 'Bash' && S.path !== undefined
    if (bash) {
      const input = e as unknown as Record<string, unknown>
      let sessionId: string | undefined
      try {
        sessionId = await $.session.id()
      } catch {
        // Without the id the panel cannot find the output; the chip says so
      }
      S.shells.set(id, {
        command: typeof input.command === 'string' ? input.command : '',
        description: typeof input.description === 'string' ? input.description : undefined,
        startedAt: now(),
        sessionId,
        background: false
      })
    }
    bump(
      (fn) => $.clock.after(WRITE_DELAY_MS, fn),
      () => $.fs.write(S.path ?? '', text())
    )
    try {
      const answer = await next(e)
      const result = (answer as { result?: unknown }).result
      const taskId =
        typeof result === 'object' && result !== null
          ? (result as { backgroundTaskId?: unknown }).backgroundTaskId
          : undefined
      const shell = S.shells.get(id)
      if (bash && shell && typeof taskId === 'string') {
        shell.background = true
        shell.taskId = taskId
        const background = [...S.shells].filter(([, entry]) => entry.background)
        for (const [key] of background.slice(0, Math.max(0, background.length - SHELLS_MAX))) {
          S.shells.delete(key)
        }
      }
      return answer
    } finally {
      if (!S.shells.get(id)?.background) S.shells.delete(id)
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
    if (S.path !== undefined && e.reason !== 'refusal' && e.answer.trim().length > 0) {
      // Not awaited: the turn end must not wait for Haiku. A newer answer cancels this one.
      S.summaryAbort?.abort()
      const abort = new AbortController()
      S.summaryAbort = abort
      const promptsAtAnswer = S.prompts
      const answer = e.answer
      const land = (line: string) => {
        S.lastSummary = line
        // Only while the person has replied to this answer at most once since
        if (S.prompts === promptsAtAnswer + 1) S.before = line
        bump(
          (fn) => $.clock.after(WRITE_DELAY_MS, fn),
          () => $.fs.write(S.path ?? '', text())
        )
      }
      $.model
        .complete(
          {
            model: SUMMARY_MODEL,
            effort: 'low',
            maxTokens: 400,
            system: SUMMARY_SYSTEM,
            prompt: answer.slice(0, SUMMARY_INPUT_MAX)
          },
          { signal: abort.signal }
        )
        .then((r) => {
          if (abort.signal.aborted) return
          land(r.isAnswered ? oneLine(r.text) : fallbackLine(answer))
        })
        .catch(() => {
          if (!abort.signal.aborted) land(fallbackLine(answer))
        })
    }
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

  // The person's own `/color` recolours the panel's prompt bar too, or the bar and Claude's input
  // frame disagree. `/color green` names it. The bare `/color` picks one at random (2.1.319) and
  // answers with a drawn row, no text (`{ ref }`, logged) — so the mod makes that pick itself,
  // among the colours other than the current one, and hands it on as the argument.
  on('command.run', { command: 'color' }, async ($, e, next) => {
    let chosen = e.args.trim().toLowerCase()
    if (chosen === '') {
      const others = [...COLORS].filter((c) => c !== S.color)
      chosen = others[Math.floor(Math.random() * others.length)] ?? 'default'
    }
    const result = await next({ ...e, args: chosen })
    if (COLORS.has(chosen) || chosen === 'default') {
      S.color = chosen === 'default' ? undefined : chosen
      S.colorApplied = true
      bump(
        (fn) => $.clock.after(WRITE_DELAY_MS, fn),
        () => $.fs.write(S.path ?? '', text())
      )
    }
    return result
  })

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

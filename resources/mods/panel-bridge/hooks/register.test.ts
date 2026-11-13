import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const DIR = '/tmp/status'
const TAB = 'tab-1'

type Written = Record<string, unknown>

/** The world beneath the plugin: the engine's answers nothing in a test gives on its own. */
const bottom = (
  on: On,
  usage: { window: number; tokens?: number; cost?: number },
  envWrites: (string | undefined)[] = []
) => {
  const writes: Written[] = []
  on('fs.write', ($, e) => {
    writes.push(JSON.parse(e.text) as Written)
    return { value: undefined }
  })
  on('env.set', ($, e) => {
    envWrites.push(e.value)
    // `{}` since 2.1.319 (EnvSetResult: absent `deny` means written); `undefined` before
    return { value: {} }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: usage.window, tokens: usage.tokens },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-06T20:00:00Z' },
        { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-10T18:00:00Z' }
      ],
      cost: usage.cost === undefined ? undefined : { usd: usage.cost }
    }
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('classic.PermissionRequest', () => ({}))
  // The engine's own stream, with nothing to stream: only the result counts beneath a test
  // eslint-disable-next-line require-yield
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: USAGE
    }
  })
  return writes
}

const last = (writes: Written[]) => writes[writes.length - 1]!

const USAGE = {
  model: 'claude-fable-5-1',
  input_tokens: 1200,
  output_tokens: 80,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 800
}

test('a step writes the live context, a tool call the row text, the turn end the idle state', async ($, on) => {
  const writes = bottom(on, { window: 1_000_000, cost: 0.5 })
  mock.env(on, { CLAUDE_PANEL_STATUS_DIR: DIR, CLAUDE_PANEL_TAB_ID: TAB })
  const clock = mock.clock(on, { now: 1_000 })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.advance(400)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  await $.session.start({ cwd: '/Users/me/p', surface: 'terminal', isInteractive: true })
  await clock.advance(200)
  expect(writes.length).toBe(1)
  expect(last(writes).state).toBe('idle')
  expect(last(writes).cwd).toBe('/Users/me/p')
  expect(last(writes).totalTokens).toBeUndefined()
  expect(last(writes).sessionPercent).toBe(12.5)
  expect(last(writes).costUsd).toBe(0.5)

  await $.turn.start({ turnId: 't1', text: '  compile\n it ' })
  await clock.advance(200)
  expect(last(writes).state).toBe('busy')
  expect(last(writes).prompt).toBe('compile it')
  expect(typeof last(writes).promptAt).toBe('number')

  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: '  npm   run compile ' })
  await clock.advance(150)
  const tool = last(writes).tool as { name: string; summary: string; startedAt: number }
  expect(tool.name).toBe('Bash')
  expect(tool.summary).toBe('npm run compile')
  // Wall-clock, like `stateAt`: the webview counts the run time against Date.now()
  expect(typeof tool.startedAt).toBe('number')
  await call
  await clock.advance(150)
  expect(last(writes).tool).toBeUndefined()

  const step = $.turn.step({
    turnId: 't1',
    index: 2,
    model: 'claude-fable-5-1',
    effort: 'high',
    messageCount: 9
  })
  // the engine's own stream: nothing beneath yields, so only the result counts
  for await (const _chunk of step) {
    // no chunks beneath a test
  }
  await clock.advance(150)
  expect(last(writes).usedTokens).toBe(1200 + 100_000 + 800)
  expect(last(writes).totalTokens).toBe(1_000_000)
  expect(last(writes).usedPercent).toBe(10.2)
  expect(last(writes).stepIndex).toBe(2)
  expect(last(writes).modelId).toBe('claude-fable-5-1')
  expect(last(writes).effort).toBe('high')

  await $.turn.complete({
    turnId: 't1',
    answer: 'done',
    durationMs: 900,
    isAborted: false,
    reason: 'answer',
    usage: USAGE
  })
  await clock.advance(150)
  expect(last(writes).state).toBe('idle')
  // The prompt outlives the turn: the bar shows it while Claude waits
  expect(last(writes).prompt).toBe('compile it')
})

test('a permission request asks, a nested session is kept off, /clear resets the counters', async ($, on) => {
  const envWrites: (string | undefined)[] = []
  const writes = bottom(on, { window: 200_000 }, envWrites)
  mock.env(on, {
    CLAUDE_PANEL_STATUS_DIR: DIR,
    CLAUDE_PANEL_TAB_ID: TAB,
    // The test's `$` has no plugin noun, so the own folder cannot be named here; what the mod
    // must keep is what this checks.
    CLAUDE_CODE_PLUGIN_DIRS: '/Users/me/own-mod'
  })
  const clock = mock.clock(on, { now: 5_000 })

  await $.session.start({ cwd: '/Users/me/p', surface: 'terminal', isInteractive: true })
  // The plugin folder list without the mod's own, then CLAUDE_PANEL_COLOR cleared for children
  expect(envWrites).toEqual(['/Users/me/own-mod', undefined])

  await $.turn.start({ turnId: 't2', text: 'rm it' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } })
  await clock.advance(150)
  expect(last(writes).state).toBe('asking')

  await $.session.measure({
    context: { window: 200_000, tokens: 50_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 33 }],
    cost: { usd: 2 },
    changed: ['context', 'rateLimits', 'cost']
  })
  await clock.advance(150)
  expect(last(writes).usedTokens).toBe(50_000)
  expect(last(writes).usedPercent).toBe(25)
  expect(last(writes).sessionPercent).toBe(33)
  expect(last(writes).costUsd).toBe(2)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const final = last(writes)
  expect(final.prompt).toBeUndefined()
  expect(final.state).toBe('idle')
  expect(final.usedTokens).toBeUndefined()
  expect(final.compacted).toBe(0)
  expect(final.costUsd).toBe(0)
  // Wall-clock on purpose: the watcher compares it with the producer's own timestamps
  expect((final.resetAt as number) > 0).toBe(true)
})

/** The Agent tool's call as the engine hands it to `agent.spawn`, in the background. */
const spawnInput = (toolUseId: string, prompt: string) => ({
  tool_use_id: toolUseId,
  prompt,
  description: prompt,
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false
})

test('a background agent outlives the turn that spawned it: counted until its own turn ends', async ($, on) => {
  const writes = bottom(on, { window: 1_000_000 })
  mock.env(on, { CLAUDE_PANEL_STATUS_DIR: DIR, CLAUDE_PANEL_TAB_ID: TAB })
  const clock = mock.clock(on, { now: 1_000 })
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${String(++spawned)}` }))
  // What the engine says of its agents when the main turn ends: a1 still at work, a2 done.
  const status: Record<string, 'running' | 'completed'> = { a1: 'running', a2: 'completed' }
  on('agent.list', () => ({
    value: Object.entries(status).map(([id, s]) => ({
      id,
      description: id,
      type: 'Explore',
      status: s
    }))
  }))

  await $.session.start({ cwd: '/Users/me/p', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't7', text: 'look around' })
  await $.agent.spawn(spawnInput('s1', 'count the files'))
  await $.agent.spawn(spawnInput('s2', 'read the readme'))
  await clock.advance(150)
  expect(last(writes).agents).toBe(2)

  // The main turn ends while a1 runs in the background: Claude waits for the person, a1 still counts.
  await $.turn.complete({
    turnId: 't7',
    answer: 'started',
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
    usage: USAGE
  })
  await clock.advance(150)
  expect(last(writes).state).toBe('idle')
  expect(last(writes).agents).toBe(1)

  // A new turn (the agent's notification, or the person typing) keeps it too.
  await $.turn.start({ turnId: 't8', text: '' })
  await clock.advance(150)
  expect(last(writes).agents).toBe(1)
  // An empty continuation and the engine's own markup keep the person's last prompt
  expect(last(writes).prompt).toBe('look around')
  await $.turn.start({ turnId: 't9', text: '<task-notification>a1 done</task-notification>' })
  await clock.advance(150)
  expect(last(writes).prompt).toBe('look around')

  // Its own turn end takes it off.
  await $.turn.complete({
    turnId: 'a1-t',
    agentId: 'a1',
    answer: '12',
    durationMs: 10,
    isAborted: false,
    reason: 'answer'
  })
  await clock.advance(150)
  expect(last(writes).agents).toBe(0)
})

test('without the panel variables the mod writes nothing', async ($, on) => {
  const writes = bottom(on, { window: 200_000 })
  mock.env(on, {})
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't3', text: 'hi' })
  await clock.advance(500)
  expect(writes.length).toBe(0)
})

test('the tab colour runs /color once, at the first real prompt, never at the start', async ($, on) => {
  const writes = bottom(on, { window: 200_000 })
  const runs: { command: string; args: string }[] = []
  on('command.run', (_, e) => {
    runs.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  mock.env(on, {
    CLAUDE_PANEL_STATUS_DIR: DIR,
    CLAUDE_PANEL_TAB_ID: TAB,
    CLAUDE_PANEL_COLOR: 'pink'
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(150)
  // A tab nobody types into must leave no transcript behind, or `--continue` reopens it
  expect(runs).toEqual([])
  // …while the panel's bar is tinted from the start
  expect(last(writes).color).toBe('pink')

  // A continuation is no prompt
  await $.turn.start({ turnId: 't0', text: '' })
  await clock.advance(150)
  expect(runs).toEqual([])

  await $.turn.start({ turnId: 't1', text: 'hello' })
  await clock.advance(150)
  expect(runs).toEqual([{ command: 'color', args: 'pink' }])

  await $.turn.start({ turnId: 't2', text: 'again' })
  await clock.advance(150)
  expect(runs.length).toBe(1)
})

test('the person’s own /color before the first prompt leaves the mod’s out', async ($, on) => {
  bottom(on, { window: 200_000 })
  const runs: string[] = []
  on('command.run', (_, e) => {
    runs.push(e.args)
    return { text: '' }
  })
  mock.env(on, {
    CLAUDE_PANEL_STATUS_DIR: DIR,
    CLAUDE_PANEL_TAB_ID: TAB,
    CLAUDE_PANEL_COLOR: 'pink'
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('green'))
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await clock.advance(150)
  expect(runs).toEqual(['green'])
})

test('an unknown colour runs no /color', async ($, on) => {
  bottom(on, { window: 200_000 })
  const runs: string[] = []
  on('command.run', (_, e) => {
    runs.push(e.args)
    return { text: '' }
  })
  mock.env(on, {
    CLAUDE_PANEL_STATUS_DIR: DIR,
    CLAUDE_PANEL_TAB_ID: TAB,
    CLAUDE_PANEL_COLOR: 'magenta; rm'
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await clock.advance(150)
  expect(runs).toEqual([])
})

/** `/color <args>` as the person types it; `''` is the bare command, which picks at random. */
const typed = (args: string) => ({
  command: 'color',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 }
})

test('the person’s own /color recolours the bar; the bare one gets its colour from the mod', async ($, on) => {
  const writes = bottom(on, { window: 200_000 })
  const seen: string[] = []
  on('command.run', (_, e) => {
    seen.push(e.args)
    return { text: `Session color set to: ${e.args}` }
  })
  mock.env(on, {
    CLAUDE_PANEL_STATUS_DIR: DIR,
    CLAUDE_PANEL_TAB_ID: TAB,
    CLAUDE_PANEL_COLOR: 'pink'
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(150)
  expect(last(writes).color).toBe('pink')

  await $.command.run(typed('green'))
  await clock.advance(150)
  expect(last(writes).color).toBe('green')

  // The bare command: the mod picks a colour other than the current one and passes it on, so the
  // engine sets the same one the bar shows
  await $.command.run(typed(''))
  await clock.advance(150)
  const picked = seen[seen.length - 1]!
  expect(picked).not.toBe('green')
  expect(['red', 'blue', 'yellow', 'purple', 'orange', 'pink', 'cyan']).toContain(picked)
  expect(last(writes).color).toBe(picked)

  await $.command.run(typed('default'))
  await clock.advance(150)
  expect(last(writes).color).toBeUndefined()
})

/** A main-thread turn end with the answer the person will reply to. */
const answered = (turnId: string, answer: string) => ({
  turnId,
  answer,
  durationMs: 10,
  isAborted: false,
  reason: 'answer' as const,
  usage: USAGE
})

const HAIKU_USAGE = {
  input_tokens: 300,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0
}

test('the line above the prompt is Haiku’s summary of the answer the prompt replies to', async ($, on) => {
  const writes = bottom(on, { window: 200_000 })
  // Haiku answers when the test says so, to cover a summary that lands after the next prompt
  const pending: ((text: string) => void)[] = []
  const asked: string[] = []
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    return new Promise((resolve) => {
      pending.push((text) =>
        resolve({ value: { isAnswered: true as const, text, usage: HAIKU_USAGE } })
      )
    })
  })
  mock.env(on, { CLAUDE_PANEL_STATUS_DIR: DIR, CLAUDE_PANEL_TAB_ID: TAB })
  const clock = mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

  // First prompt: nothing before it yet
  await $.turn.start({ turnId: 't1', text: 'compile it' })
  await clock.advance(150)
  expect(last(writes).before).toBeUndefined()

  // Its answer goes to Haiku once, not awaited by the turn end
  await $.turn.complete(answered('t1', 'Compiled. Two warnings remain.\nShall I fix them?'))
  expect(asked).toEqual(['Compiled. Two warnings remain.\nShall I fix them?'])
  pending.shift()!('Build compiles; two warnings open\n')
  await clock.advance(150)

  // The reply to that answer carries its line
  await $.turn.start({ turnId: 't2', text: 'yes, fix them' })
  await clock.advance(150)
  expect(last(writes).before).toBe('Build compiles; two warnings open')

  // An answer whose summary lands only after the next prompt still reaches that prompt
  await $.turn.complete(answered('t2', 'Fixed both warnings.'))
  await $.turn.start({ turnId: 't3', text: 'commit' })
  await clock.advance(150)
  expect(last(writes).before).toBe('Build compiles; two warnings open')
  pending.shift()!('Warnings fixed; ready to commit')
  await clock.advance(150)
  expect(last(writes).before).toBe('Warnings fixed; ready to commit')

  // A subagent's turn end asks nothing
  await $.turn.complete({ ...answered('a1-t', 'agent report'), agentId: 'a1' })
  expect(asked.length).toBe(2)

  // /clear drops both lines
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(last(writes).before).toBeUndefined()
  expect(last(writes).prompt).toBeUndefined()
})

test('without a summary from Haiku the line is the answer’s first line', async ($, on) => {
  const writes = bottom(on, { window: 200_000 })
  on('model.complete', () => ({
    value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: HAIKU_USAGE }
  }))
  mock.env(on, { CLAUDE_PANEL_STATUS_DIR: DIR, CLAUDE_PANEL_TAB_ID: TAB })
  const clock = mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'look' })
  await $.turn.complete(answered('t1', '\n  Found three callers of resize().\nDetails below.'))
  await clock.advance(150)
  await $.turn.start({ turnId: 't2', text: 'show me' })
  await clock.advance(150)
  expect(last(writes).before).toBe('Found three callers of resize().')
})

test('a skill and a ! line show as typed; a local command and a notification keep the prompt', async ($, on) => {
  const writes = bottom(on, { window: 200_000 })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  mock.env(on, { CLAUDE_PANEL_STATUS_DIR: DIR, CLAUDE_PANEL_TAB_ID: TAB })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  // As the engine raises them (2.1.319, measured): `prompt.submit` first, its turn inside `next`
  const submit = (text: string, kind: 'composer' | 'task-notification' = 'composer') =>
    $.prompt.submit({ text, origin: { kind }, wait: false })

  await submit('compile it')
  await $.turn.start({ turnId: 't1', text: 'compile it' })
  await clock.advance(150)
  expect(last(writes).prompt).toBe('compile it')

  // A skill: the turn opens on markup, the bar shows what was typed
  await submit('/code-review high')
  await $.turn.start({
    turnId: 't2',
    text: '<command-message>code-review</command-message>\n<command-name>/code-review</command-name>'
  })
  await clock.advance(150)
  expect(last(writes).prompt).toBe('/code-review high')

  // A ! line raises no prompt.submit; the engine records it, then starts a turn on its output
  const row = (text: string) => ({
    message: {
      type: 'user' as const,
      role: 'user' as const,
      content: [{ type: 'text' as const, text }]
    },
    door: 'command' as const,
    origin: { kind: 'unclassified' as const },
    uuid: `u-${text.length}`
  })
  await $.session.append(row('<bash-input>npm test</bash-input>'))
  await $.session.append(row('<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'))
  await $.turn.start({
    turnId: 't3',
    text: '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'
  })
  await clock.advance(150)
  expect(last(writes).prompt).toBe('!npm test')

  // A local command (/context) raises neither, and a notification is not the person's
  await submit('<task-notification>a1 done</task-notification>', 'task-notification')
  await $.turn.start({ turnId: 't4', text: '<task-notification>a1 done</task-notification>' })
  await clock.advance(150)
  expect(last(writes).prompt).toBe('!npm test')
})

test('a Bash call lists as a shell while it runs; a background one stays with its task id', async ($, on) => {
  const writes = bottom(on, { window: 1_000_000 })
  mock.env(on, { CLAUDE_PANEL_STATUS_DIR: DIR, CLAUDE_PANEL_TAB_ID: TAB })
  const clock = mock.clock(on, { now: 1_000 })
  let session = 'sess-1'
  on('session.id', () => ({ value: session }))
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    await clock.advance(400)
    const input = e as unknown as { run_in_background?: boolean }
    return {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        backgroundTaskId: input.run_in_background ? 'b9bxey20n' : undefined
      }
    }
  })
  type Shell = {
    key: string
    command: string
    description?: string
    startedAt: number
    sessionId?: string
    sessionIds?: string[]
    background: boolean
    taskId?: string
  }
  const shells = () => (last(writes).shells ?? []) as Shell[]

  await $.session.start({ cwd: '/Users/me/p', surface: 'terminal', isInteractive: true })
  const fore = $.tool.call({
    tool: 'Bash',
    tool_use_id: 'f1',
    command: 'npm test',
    description: 'Run the tests'
  })
  await clock.advance(150)
  expect(shells()).toEqual([
    {
      key: 'f1',
      command: 'npm test',
      description: 'Run the tests',
      startedAt: shells()[0]!.startedAt,
      sessionId: 'sess-1',
      sessionIds: ['sess-1'],
      background: false
    }
  ])
  await fore
  await clock.advance(150)
  expect(shells()).toEqual([])

  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'b1',
    command: 'npm run watch',
    run_in_background: true
  })
  await clock.advance(150)
  expect(shells().map((s) => [s.key, s.background, s.taskId, s.sessionId])).toEqual([
    ['b1', true, 'b9bxey20n', 'sess-1']
  ])

  // A /clear gives the session a new id, but Claude Code keeps the output folder under the old
  // one: every call names all ids the process has had, and the background call survives the clear
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  session = 'sess-2'
  await $.session.start({ cwd: '/Users/me/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'b2',
    command: 'sleep 2',
    run_in_background: true
  })
  await clock.advance(150)
  expect(shells().map((s) => [s.key, s.sessionId, s.sessionIds])).toEqual([
    ['b1', 'sess-1', ['sess-1']],
    ['b2', 'sess-2', ['sess-1', 'sess-2']]
  ])
})

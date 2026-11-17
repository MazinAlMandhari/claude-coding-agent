import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-crew',
  component: 'Pane',
  requestId: 'agent-crew',
  props: {
    title: 'My agents',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAR = {
  plugin: 'agent-crew',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

type On = Parameters<TestBody>[1]

/** Stand in for the engine beneath the mod: a clock that moves 5 s per read, and the setup calls. */
function engine(on: On, opened: string[] = []) {
  let ms = 1_000_000
  on('clock.now', () => ({ value: (ms += 5_000) }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'my-agents' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-crew__crew_status' } }))
}

const finish = (agentId: string) => ({ agentId, reason: 'answer', answer: 'ok' }) as never

const spawn = (type: string, description: string, id: string) =>
  ({ tool_use_id: `t-${id}`, prompt: 'work', description, subagentType: type }) as never

test('the terminal pane lists the crew lineup before any run', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const lineup = (await ui.find({ type: 'Text', text: /◆.*▲.*●.*■.*◈.*✱.*★/ }))?.text ?? ''
  expect(lineup).toContain('◆')
  expect(await ui.find({ type: 'Text', text: /No agent runs yet/ })).toBeTruthy()
  await ui.unmount()
})

test('a crew run is tracked from running to done, with its model', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawn('code-reviewer', 'Review login fix', 'a1'))

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Code reviewer · Opus 5.5/ }))?.text).toBeTruthy()
  await ui.unmount()

  await $.turn.complete(finish('a1'))

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeFalsy()
  await ui.unmount()
})

test('the desktop pane draws the header, the lineup and a row per run as pictures', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'v1' }))

  await $.agent.spawn(spawn('verifier', 'Run the checks', 'v1'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeTruthy()
  await ui.unmount()
})

test('the progress bar counts the batch: 1 of 2 done', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `b${++n}` }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawn('code-reviewer', 'Review', 'b1'))
  await $.agent.spawn(spawn('security-reviewer', 'Security review', 'b2'))
  await $.turn.complete(finish('b1'))

  const ui = await $.ui.mount({ ...BAR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\/2 done/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeTruthy()
  await ui.unmount()

  await $.turn.complete(finish('b2'))
  const done = await $.ui.mount({ ...BAR, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /all done/ })).toBeTruthy()
  await done.unmount()
})

test('agents started together after a finished batch share one new batch', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `p${++n}` }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawn('verifier', 'Earlier check', 'p1'))
  await $.turn.complete(finish('p1'))
  // Two reviewers launched in one message start at the same time.
  await Promise.all([
    $.agent.spawn(spawn('code-reviewer', 'Review', 'p2')),
    $.agent.spawn(spawn('security-reviewer', 'Security review', 'p3')),
  ])

  const ui = await $.ui.mount({ ...BAR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /0\/2 done/ })).toBeTruthy()
  await ui.unmount()
})

test('the desktop bar drawing shrinks to fit so its buttons stay in view', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'd1' }))

  await $.agent.spawn(spawn('verifier', 'Run the checks', 'd1'))

  const ui = await $.ui.mount({ ...BAR, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeTruthy()
  expect(svg?.props.width).toBeUndefined()
  const drawing = (await ui.find({ type: 'Box', key: 'crew-bar-drawing' }))?.props
  expect(drawing?.minWidth).toBe(0)
  expect(drawing?.flexShrink).toBe(1)
  expect((await ui.find({ type: 'Box', key: 'crew-bar-buttons' }))?.props.flexShrink).toBe(0)
  const labels = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
  expect(labels).toContain('×7')
  expect(labels).toContain('✕')
  await ui.unmount()
})

test('no bar and no row for agents outside the crew', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'x1' }))

  await $.agent.spawn(spawn('Explore', 'Search the repo', 'x1'))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Search the repo/ })).toBeFalsy()
  await pane.unmount()
  const bar = await $.ui.mount({ ...BAR, surface: 'terminal' })
  expect(await bar.find({ type: 'Text', text: /done/ })).toBeFalsy()
  await bar.unmount()
})

test('the panel opens by itself when a session starts', async ($, on) => {
  const opened: string[] = []
  engine(on, opened)
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(opened).toContain('agent-crew')
})

test('the widget form shows the lineup', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'widget' } })
  const text = (await ui.find({ type: 'Text' }))?.text ?? ''
  for (const shape of ['◆', '▲', '●', '■', '◈', '✱', '★']) expect(text).toContain(shape)
  await ui.unmount()
})

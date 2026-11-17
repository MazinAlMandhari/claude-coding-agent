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

test('the crew lineup in the desktop pane is drawn large even when nobody works', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 81 } })
  const lineup = (await ui.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('Crew:'))
  expect(lineup).toBeTruthy()
  // About 2x the crab's 28-unit height: well above the old 34 px strip.
  expect(Number(lineup?.props.height)).toBeGreaterThanOrEqual(56)
  await ui.unmount()
})

test('a working crab dances and waves a free claw while idle crabs keep still', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'z1' }))

  await $.agent.spawn(spawn('code-reviewer', 'Review login fix', 'z1'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 81 } })
  const source = String((await ui.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('Crew:'))?.props.source)
  expect(source).toContain('@keyframes dance')
  expect(source).toContain('class="c-code-reviewer run"><g class="sw">')
  expect(source).toContain('class="c-planner"><g class="sw">')
  // Every costume keeps at least one claw free to wave (the others hold its prop).
  const crabs = source.split('class="c-').slice(1)
  expect(crabs.length).toBe(7)
  for (const crab of crabs) {
    expect(/class="c[ab]"/.test(crab)).toBe(true)
    // Claws come first, under the costume, so the astronaut's glass dome still covers them.
    expect(crab.indexOf('<g class="c')).toBeLessThan(crab.indexOf('<rect'))
  }
  await ui.unmount()
})

test('the pane grows by exactly the extra height of the larger lineup', async ($, on) => {
  engine(on)
  const measure = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } })
    const svgs = await ui.findAll({ type: 'Svg' })
    const grid = svgs.filter(s => s.props.alt === 'dotted grid').reduce((sum, s) => sum + Number(s.props.height), 0)
    const lineup = Number(svgs.find(s => String(s.props.alt).startsWith('Crew:'))?.props.height)
    await ui.unmount()
    return { grid, lineup }
  }
  const narrow = await measure(20)
  const wide = await measure(81)
  // Narrow panes keep the usual crab size (1.1x: 37 px strip); the grid under the content must
  // grow with the strip, or the last row would be cut off.
  expect(narrow.lineup).toBe(37)
  expect(wide.grid - narrow.grid).toBe(wide.lineup - narrow.lineup)
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

test('the pane lists only the latest batch and folds earlier runs under Earlier', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `e${++n}` }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawn('code-reviewer', 'Old review', 'e1'))
  await $.turn.complete(finish('e1'))
  await Promise.all([$.agent.spawn(spawn('planner', 'New plan', 'e2')), $.agent.spawn(spawn('verifier', 'New check', 'e3'))])
  await $.turn.complete(finish('e2'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /New plan/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /New check/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Old review/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'earlier' })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'earlier' }))?.props.label).toContain('Earlier · 1')

  await ui.press({ key: 'earlier' })
  expect(await ui.find({ type: 'Text', text: /Old review/ })).toBeTruthy()
  await ui.unmount()
})

test('a run still going keeps its batch open, so runs that finish meanwhile are not folded', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `k${++n}` }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawn('verifier', 'Long check', 'k1'))
  await $.agent.spawn(spawn('code-reviewer', 'Quick review', 'k2'))
  await $.turn.complete(finish('k2'))
  await $.agent.spawn(spawn('debugger', 'Later fix', 'k3'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Quick review/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'earlier' })).toBeFalsy()
  await ui.unmount()
})

test('with a single batch there is nothing to fold', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawn('debugger', 'Only run', 's1'))
  await $.turn.complete(finish('s1'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'earlier' })).toBeFalsy()
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

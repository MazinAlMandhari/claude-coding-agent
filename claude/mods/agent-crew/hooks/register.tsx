// agent-crew: a "My agents" panel and a progress bar above the prompt for your own subagents.
//
// The pixel crab, its walking animation, the dotted progress bar, the panel rows, the cost
// table and the context tracking are adapted from savvy-progress by johnnyvizz
// (https://github.com/johnnyvizz/claude-kit, MIT License; see NOTICE). The costumes for the
// planner, test writer, security reviewer and debugger are new; the astronaut, detective and
// engineer costumes are savvy-progress's own, recoloured per agent.

import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, AgentSpawnResult, EngineInterface, Register } from 'claude-code'

import type { AgentRun, Batch, Panel, RunStatus } from '../types'

const PANE = 'agent-crew'
const TITLE = 'My agents'
const COMMAND = 'my-agents'
const STATUS_TOOL = 'crew_status'

/** The crew: each agent's colour (matches its agent file), a shape for the terminal, and a role line. */
export const CREW = [
  { type: 'planner', label: 'Planner', color: '#3b82f6', glyph: '◆', role: 'plans the work' },
  { type: 'test-writer', label: 'Test writer', color: '#22c55e', glyph: '▲', role: 'writes tests first' },
  { type: 'verifier', label: 'Verifier', color: '#eab308', glyph: '●', role: 'runs the checks' },
  { type: 'code-reviewer', label: 'Code reviewer', color: '#ef4444', glyph: '■', role: 'reviews the diff' },
  { type: 'security-reviewer', label: 'Security reviewer', color: '#a855f7', glyph: '◈', role: 'secrets, privacy, injection' },
  { type: 'debugger', label: 'Debugger', color: '#f97316', glyph: '✱', role: 'finds root causes' },
  { type: 'ai-agent-engineer', label: 'AI agent engineer', color: '#06b6d4', glyph: '★', role: 'prompts, tools, evals' },
] as const

type Member = (typeof CREW)[number]

const memberOf = (type: string): Member | undefined => CREW.find(m => m.type === type.replace(/^[^:]*:/, ''))
const colorOf = (type: string): string => memberOf(type)?.color ?? '#888780'

// ---------------------------------------------------------------------------- state

// Change a tag when that value's fields change: it declines what an earlier version stored.
const runs = atom({ plugin: 'agent-crew', key: 'runs' } as const, [] as AgentRun[], { shape: 'runs-2' })
const panel = atom({ plugin: 'agent-crew', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  isCrewOpen: false,
} as Panel)
const now = atom({ plugin: 'agent-crew', key: 'now' } as const, 0)
const batch = atom({ plugin: 'agent-crew', key: 'batch' } as const, null as Batch | null)

// ---------------------------------------------------------------------------- numbers

const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// USD per million tokens: input, output, cache read, cache write (list prices, 2026-10-10,
// from savvy-progress). An estimate from token counts, not a bill.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 8]
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const tokensOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// Runs that overlap in time form one batch: a run starts a new batch when every run before it has
// ended. The pane lists the latest batch and folds the earlier ones, so a long session doesn't
// show each agent many times over.
const batchesOf = (list: AgentRun[]): AgentRun[][] => {
  const groups: AgentRun[][] = []
  let openUntil = -Infinity
  for (const a of [...list].sort((x, y) => x.startedAt - y.startedAt)) {
    const current = groups.at(-1)
    if (current === undefined || a.startedAt >= openUntil) groups.push([a])
    else current.push(a)
    openUntil = Math.max(openUntil, a.status === 'running' ? Infinity : (a.endedAt ?? a.startedAt))
  }
  return groups
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// ---------------------------------------------------------------------------- text sizing

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charEm = (ch: string): number =>
  /[؀-ۿ]/.test(ch) ? 0.5 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zm w@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// ---------------------------------------------------------------------------- the crab

// Pixel Clawd: a 24×18 crab on a 30×28 grid. The body keeps the brand clay; each agent's
// colour lives in its costume.
const CLAY = '#D97757'
const INK = '#1F1E1D'
const CRAB_BOX = 30
const CRAB_SCALE = 1.1

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its costume,
// `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armFront` raises the front claw (-4) to hold a prop. A free claw (`ca` back, `cb` front)
// waves while the crab dances; a claw holding a prop passes `bd` (it stays put) or the prop's
// class (it travels with the prop).
const crabBody = (f: Fill, armFront = 0, armCls = 'cb', backCls = 'ca'): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY, backCls)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

const GLASS = 'rgba(169,214,245,.7)'
const WHITE = '#F8F6F1'
const STEEL = '#B8BCC4'
const GREY = '#8E929A'
const WOOD = '#7A4A26'

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Planner: cap and clipboard; the pencil scribbles the plan.
  planner: (f, t) => {
    crabBody(f, -4, 'bd')
    stamp(f, 6, 5, ['.....tttttttt.....', '...tttttwwttttt...', '..ttttttwwtttttt..', '..ttttttttttttttdddd', 'dddddddddddddddddd'], { t, w: WHITE, d: '#1E40AF' })
    stamp(f, 24, 3, ['.kk..', 'bbbbb', 'bwwwb', 'bkkwb', 'bwwwb', 'bkkwb', 'bwwwb', 'bbbbb'], { b: '#8B5A2B', w: WHITE, k: GREY })
    f(27, 5, 1, 3, '#F5C542', 'pen')
    f(27, 8, 1, 1, INK, 'pen')
  },
  // Test writer: scientist with goggles and wild hair; the flask bubbles.
  'test-writer': (f, t) => {
    crabBody(f, -4, 'bd')
    stamp(f, 7, 6, ['.w....w....w..', 'ww..www..ww.w.', '.wwwwwwwwwwwww', 'wwwwwwwwwwwwww'], { w: '#EDEDEA' })
    for (const x of [8, 18]) {
      f(x, 11, 4, 1, GREY); f(x, 14, 4, 1, GREY); f(x, 11, 1, 4, GREY); f(x + 3, 11, 1, 4, GREY)
    }
    f(12, 12, 6, 1, GREY)
    stamp(f, 23, 4, ['..cc..', '..cc..', '.cggc.', 'cggggc', 'cggggc', 'cccccc'], { c: '#C9CCD2', g: t })
    f(24, 2, 1, 1, t, 'b1')
    f(26, 0, 1, 1, t, 'b2')
  },
  // Verifier: engineer in a hard hat; the wrench turns a bolt.
  verifier: (f, t) => {
    crabBody(f, 0, 'cb', 'bd')
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: t, h: '#FBE08A', d: '#A16207' })
    f(13, 5, 4, 2, INK)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: GREY }, 'it')
  },
  // Code reviewer: detective with a deerstalker; the magnifier sweeps and glints.
  'code-reviewer': (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, GLASS, 'it'); f(25, 6, 1, 4, WOOD, 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Security reviewer: knight with a plumed helmet; the shield glints, the plume waves.
  'security-reviewer': (f, t) => {
    crabBody(f, -4, 'bd')
    stamp(f, 13, 0, ['.pp', 'ppp', 'pp.'], { p: t }, 'plume')
    stamp(f, 6, 3, ['....ssssssssss....', '...sssssssssssss..', '..ssssssssssssss..', '..sssssssssssssss.', '.ssssssssssssssss.', '.ssssssssssssssss.', 'dddddddddddddddddd'], { s: STEEL, d: GREY })
    f(14, 4, 2, 5, '#D9DCE2')
    stamp(f, 23, 6, ['ooooo', 'otwto', 'owwwo', 'otwto', '.oto.', '..o..'], { o: GREY, t, w: WHITE })
    f(24, 7, 1, 1, '#fff', 'gl')
  },
  // Debugger: bug hunter in a pith helmet; the net swings and the bug hops away.
  debugger: (f, t) => {
    crabBody(f, 0, 'bd')
    stamp(f, 6, 4, ['.....kkkkkkkk.....', '...kkkkkkkkkkkk...', '..kkkkkkkkkkkkkk..', '..tttttttttttttt..', 'kkkkkkkkkkkkkkkkkk'], { k: '#C8B48A', t })
    stamp(f, 24, 0, ['.www.', 'w...w', 'w...w', '.www.'], { w: WHITE }, 'it')
    f(26, 4, 1, 10, WOOD, 'it')
    f(28, 6, 2, 2, '#D0453F', 'bug')
    f(28, 6, 1, 1, INK, 'bug')
  },
  // AI agent engineer: astronaut in a glass dome; floats instead of walking, antenna and star blink.
  'ai-agent-engineer': (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  plain: f => crabBody(f),
}

// Pure CSS, run by the compositor. Periods divide one second, so the once-a-second redraw of a
// running row restarts them in phase. Every crab walks and dances (sways side to side with a
// little hop, raising the claw on the side it leans to); each costume adds its prop's motion.
const CRAB_CSS = `<style>
.run .sw{transform-origin:50% 100%;animation:dance 1s ease-in-out infinite}
.run .ca{animation:pump 1s steps(1) infinite}.run .cb{animation:pump 1s steps(1) infinite -.5s}
@keyframes dance{25%{transform:translate(-1px,-1px) rotate(-4deg)}50%{transform:none}75%{transform:translate(1px,-1px) rotate(4deg)}}
@keyframes pump{12.5%{transform:translateY(-4px)}37.5%{transform:none}}
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.375s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@keyframes blink{50%{opacity:.15}}
.c-planner.run .pen{animation:scribble .5s steps(1) infinite}
@keyframes scribble{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,0)}75%{transform:translate(-1px,2px)}}
.c-test-writer.run .b1{animation:rise 1s steps(1) infinite}.c-test-writer.run .b2{animation:rise 1s steps(1) infinite -.5s}
@keyframes rise{50%{transform:translateY(-2px);opacity:.3}}
.c-verifier.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-code-reviewer.run .it{animation:scan 1s steps(1) infinite}
.c-code-reviewer.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-security-reviewer.run .gl{animation:blink .5s steps(1) infinite}
.c-security-reviewer.run .plume{transform-origin:0 100%;animation:wave .5s steps(1) infinite}
@keyframes wave{50%{transform:skewX(-15deg)}}
.c-debugger.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
.c-debugger.run .bug{animation:hop .5s steps(1) infinite -.25s}
@keyframes hop{50%{transform:translate(-1px,-1px)}}
.c-ai-agent-engineer.run{animation:float 1s ease-in-out infinite}
.c-ai-agent-engineer.run .la,.c-ai-agent-engineer.run .lb,.c-ai-agent-engineer.run .bd{animation:none}
.c-ai-agent-engineer.run .ant{animation:blink 1s steps(1) infinite}
.c-ai-agent-engineer.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const costumeOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  return bare in COSTUMES ? bare : 'plain'
}

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion; legs stay
// outside it and step on their own. The claws are drawn first, under the costume (the
// astronaut's glass dome covers them), and `sw` wraps it all so the whole crab sways.
const CLAWS = ['ca', 'cb']
// A crab at the left edge of its picture sits this far in, so its sway never clips the wrench;
// one at the top edge sits 1 down for the same reason.
const EDGE = 3

const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? COSTUMES.plain
  draw?.(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const claws = CLAWS.filter(k => groups.has(k))
  const props = [...groups.keys()].filter(k => !['bd', 'la', 'lb', ...CLAWS].includes(k))
  const body = `<g class="bd">${claws.map(group).join('')}${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}"><g class="sw">${body}${group('la')}${group('lb')}</g></g></g>`
}

// ---------------------------------------------------------------------------- the bar above the prompt

type BarState = { total: number; done: number; running: number; isFinished: boolean; costume: string }

const barOf = (b: Batch, list: AgentRun[]): BarState => {
  const inBatch = list.filter(a => b.ids.includes(a.id))
  const running = inBatch.filter(a => a.status === 'running')
  const latest = running.at(-1) ?? inBatch.at(-1)
  return {
    total: b.ids.length,
    done: inBatch.filter(a => a.status !== 'running').length,
    running: running.length,
    isFinished: inBatch.length > 0 && running.length === 0,
    costume: latest ? costumeOf(latest.type) : 'plain',
  }
}

const ratio = (s: BarState): number => (s.isFinished ? 1 : s.total ? s.done / s.total : 0)

const barLabel = (s: BarState): string => (s.isFinished ? 'all done' : `${s.done}/${s.total} done`)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return v - Math.floor(v)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines, so title, bar,
// percent and crab live in one drawing; only the crew count and the dismiss are Buttons.
const BAR_ROW_H = 22
const BAR_H = 16
const BAR_CRAB_W = 26
const CELL = 3

const barSvg = (s: BarState, W: number): string => {
  const title = TITLE
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - BAR_CRAB_W)
  const color = s.isFinished ? DONE : ACCENT
  const y0 = (BAR_ROW_H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(s))
  const runW = s.total ? Math.round((BAR_W * Math.min(s.total, s.done + s.running)) / s.total) : 0
  const dots: string[] = []
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Running, not finished yet: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }
  const ticks: string[] = []
  for (let i = 1; i < s.total; i++) {
    const x = Math.round((BAR_W * i) / s.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }
  const text = barLabel(s)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(s) * 100)}%`
  const isWorking = s.running > 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAR_ROW_H}" viewBox="0 0 ${W} ${BAR_ROW_H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
.t0,.t1,.t2,.t3{animation:tw ${s.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${s.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${s.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${s.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${s.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${BAR_ROW_H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${BAR_ROW_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - BAR_CRAB_W - 6}" y="${BAR_ROW_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - BAR_CRAB_W - 2, 1, s.costume, false, isWorking, 0.8)}
</svg>`
}

const barText = (s: BarState, width: number): string => {
  const filled = Math.round(width * ratio(s))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------- panel drawings (desktop)

// The pane's backdrop: a dotted grid as tall as the content laid over it.
const GRID_STEP = 16
const LINE_H = 24
const GRID_TILE = 4096
const ROW_H = 66
const CREW_ROW_H = 46
const LINEUP_H = 34
const HEADER_H = 44

const gridTiles = (h: number) => Array.from({ length: Math.ceil(h / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, h - i * GRID_TILE))
const gridSvg = (W: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${h}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const svg = (W: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/>`
}

const headerSvg = (W: number, t: ReturnType<typeof totals>): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(W, HEADER_H, `${tile(0, 'cost', '≈' + fmtCost(t.cost))}${tile(1, 'tokens', fmtTokens(t.tokens))}${tile(2, 'time', fmtTime(t.time))}`)
}

// The crew lineup: all seven crabs, dim when idle, walking with a live dot while working.
// In the pane the crabs grow to share the width (up to 2x, about 60 px each); the small corner
// widget keeps them at their usual size.
const CRAB_TALL = 28 // the crab's drawing is CRAB_BOX (30) x 28 units before scaling
const LINEUP_MAX_SCALE = 2
const lineupScale = (W: number): number =>
  Math.max(CRAB_SCALE, Math.min(LINEUP_MAX_SCALE, (W / CREW.length - 8) / CRAB_BOX))
const lineupHeight = (W: number): number => Math.round(CRAB_TALL * lineupScale(W)) + 6

const lineupSvg = (W: number, busy: Set<string>, isLarge = true): string => {
  if (!isLarge) {
    const step = Math.max(34, Math.min(44, Math.floor(W / CREW.length)))
    const body = CREW.map((m, i) => {
      const isBusy = busy.has(m.type)
      return crab(i * step, 1, m.type, !isBusy, isBusy) + (isBusy ? `<circle class="live" cx="${i * step + 32}" cy="5" r="3" fill="${m.color}"/>` : '')
    }).join('')
    return svg(W, LINEUP_H, body)
  }
  const scale = lineupScale(W)
  const size = CRAB_BOX * scale
  const step = W / CREW.length
  const body = CREW.map((m, i) => {
    const isBusy = busy.has(m.type)
    const x = Math.round(i * step + (step - size) / 2)
    const dot = isBusy ? `<circle class="live" cx="${x + size - 2}" cy="6" r="${Math.max(3, scale * 2)}" fill="${m.color}"/>` : ''
    return crab(x, 6, m.type, !isBusy, isBusy, scale) + dot
  }).join('')
  return svg(W, lineupHeight(W), body)
}

// One row of the "Who's who" legend: the agent, its role and what it has done so far.
const crewRowSvg = (W: number, m: Member, isBusy: boolean, count: number): string => {
  const textW = W - 42 - 22
  const note = isBusy ? 'working now' : count ? `${count} run${count === 1 ? '' : 's'} this session` : 'idle'
  return svg(
    W,
    CREW_ROW_H,
    `${crab(EDGE, 6, m.type, !isBusy, isBusy)}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600" fill="${m.color}">${xml(fitText(m.label, 13, textW))}</text>
<text class="s" x="42" y="34" font-family="${FONT}" font-size="11">${xml(fitText(`${m.role}  ·  ${note}`, 11, textW))}</text>
${statusMark(W - 8, 16, isBusy ? 'running' : count ? 'done' : 'idle', m.color)}
<line class="ln" x1="0" y1="${CREW_ROW_H - 0.5}" x2="${W}" y2="${CREW_ROW_H - 0.5}"/>`,
  )
}

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const m = memberOf(a.type)
  const color = colorOf(a.type)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const barW = textW
  // A finished run is full; a running one shows its context fill, drawn grey.
  const progress = a.status === 'done' ? 1 : null
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  const meta = [modelName(a.model)]
  if (a.status === 'failed') meta.push('failed')
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  return svg(
    W,
    ROW_H,
    `${crab(EDGE, 14, costumeOf(a.type), false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(m?.label ?? a.type)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="${ROW_H - 0.5}" x2="${W}" y2="${ROW_H - 0.5}"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], t: ReturnType<typeof totals>): string => {
  const icons = [...list.filter(a => a.status === 'running'), ...list.filter(a => a.status !== 'running')]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((a, i) => crab(i * 36 + EDGE, 1, costumeOf(a.type), false, a.status === 'running') + (a.status === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${colorOf(a.type)}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// ---------------------------------------------------------------------------- terminal drawing

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<RunStatus, string> = { running: '●', done: '✓', failed: '✗' }

// ---------------------------------------------------------------------------- engine calls
// The engine only lets `$` be passed to functions declared at the top of the file.

function open($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// Opens the pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  await update($, now, () => 0)
  await open($)
  return true
}

async function tick($: EngineInterface): Promise<void> {
  const list = await read($, runs)
  if (!list.some(a => a.status === 'running')) return
  const at = await $.clock.now()
  await update($, now, () => at)
}

async function setUp($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMMAND,
    description: 'Show the My agents panel: your own subagents, with what each is doing, its model, context, cost and time',
  })
  await $.tool.register({
    name: STATUS_TOOL,
    description:
      'Report the agent-crew mod status: whether the My agents panel is placed on screen, and the runs it holds. For debugging the mod.',
    inputSchema: { type: 'object', properties: {} },
  })
  // Ticks the running agents' clocks once a second; quiet when nothing runs.
  $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
  })
  // Shown by default: the panel opens with each session. Not awaited, so a surface that is not
  // attached yet (or too narrow) never holds up the session; it is placed when one can draw it.
  void open($).catch(() => undefined)
}

// session.start fires only when a session begins, so a mod switched on mid-session would never
// set up. Every early event calls this; it runs once per load, and again after a failure.
let ready: Promise<void> | undefined

function ensureReady($: EngineInterface): Promise<void> {
  ready ??= setUp($).catch(() => {
    ready = undefined
  })
  return ready
}

async function statusReport($: EngineInterface): Promise<string> {
  const { isPlaced } = await open($)
  const list = await read($, runs)
  const b = await read($, batch)
  return JSON.stringify({
    loaded: true,
    panelPlaced: isPlaced,
    bar: b ? barOf(b, list) : null,
    runs: list.map(r => ({ type: r.type, description: r.description, status: r.status, model: r.model, costUsd: r.costUsd })),
  })
}

// Agents launched in one message start at the same moment. Each start reads the batch, then
// writes it; run side by side, both would see the old finished batch and the last write would
// drop the others. So starts are recorded one at a time, in the order they arrive.
let startQueue: Promise<void> = Promise.resolve()

function recordStart($: EngineInterface, e: AgentSpawnInput, started: AgentSpawnResult): Promise<void> {
  const done = startQueue.then(() => recordStartNow($, e, started))
  startQueue = done.catch(() => undefined)
  return done
}

async function recordStartNow($: EngineInterface, e: AgentSpawnInput, started: AgentSpawnResult): Promise<void> {
  const at = await $.clock.now()
  const run: AgentRun = {
    id: started.agentId ?? e.tool_use_id,
    agentId: started.agentId,
    type: e.subagentType.replace(/^[^:]*:/, ''),
    description: e.description,
    status: 'running',
    startedAt: at,
    model: started.model ?? e.model ?? '',
    contextTokens: 0,
    contextMax: windowOf(started.model ?? ''),
    tokens: 0,
    costUsd: 0,
    steps: 0,
  }
  const list = await update($, runs, prev => [...prev.filter(r => r.id !== run.id), run].slice(-100))
  // A new batch starts when the previous one has finished (or was dismissed).
  const prev = await read($, batch)
  const isNewBatch = prev === null || barOf(prev, list).isFinished || prev.ids.every(id => !list.some(r => r.id === id))
  await update($, batch, b => (isNewBatch || b === null ? { ids: [run.id], startedAt: at } : { ...b, ids: [...b.ids, run.id] }))
  await update($, now, () => at)
  if (isNewBatch) {
    const { isPlaced } = await open($)
    if (!isPlaced) {
      const m = memberOf(run.type)
      await $.ui.toast(`${m?.glyph ?? '●'} ${m?.label ?? run.type} started: ${run.description}`)
    }
  }
}

async function recordStep($: EngineInterface, agentId: string, model: string, usage: Usage): Promise<void> {
  await update($, runs, list =>
    list.map((a): AgentRun =>
      a.agentId !== agentId
        ? a
        : {
            ...a,
            model,
            contextTokens: tokensOf(usage),
            contextMax: windowOf(model),
            tokens: a.tokens + tokensOf(usage),
            costUsd: a.costUsd + costOf(model, usage),
            steps: a.steps + 1,
          },
    ),
  )
}

async function recordEnd($: EngineInterface, agentId: string, status: RunStatus, usage: (Usage & { model?: string }) | undefined): Promise<void> {
  const at = await $.clock.now()
  await update($, runs, list =>
    list.map((a): AgentRun => {
      if (a.agentId !== agentId || a.status !== 'running') return a
      // A run whose steps went unseen still gets the turn's own sum.
      const fallback = a.steps === 0 && usage
      const model = (fallback && usage.model) || a.model
      return {
        ...a,
        status,
        endedAt: at,
        ...(fallback ? { model, tokens: tokensOf(usage), costUsd: costOf(model, usage) } : {}),
      }
    }),
  )
  await update($, now, () => at)
}

// ---------------------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureReady($)
    return started
  })

  // The hooks below can hold up a prompt, a tool call, a model request or an agent: a failure
  // of this mod's own work is caught so it never blocks them.

  on('prompt.submit', async ($, e, next) => {
    await ensureReady($).catch(() => undefined)
    return next(e)
  })

  on('tool.call', { tool: `mcp__agent-crew__${STATUS_TOOL}` }, async $ => {
    const status = await statusReport($).catch(err => `agent-crew status failed: ${String(err)}`)
    return { result: status }
  })

  on('command.run', { command: COMMAND }, async $ => {
    await update($, now, () => 0).catch(() => undefined)
    const { isPlaced } = await open($).catch(() => ({ isPlaced: false }))
    return {
      text: isPlaced
        ? 'My agents panel opened (look on the right of the chat).'
        : 'My agents panel was opened, but this app did not place it on screen.',
    }
  })

  // One of the crew starts: add a run, extend the bar's batch, bring the panel up.
  on('agent.spawn', async ($, e, next) => {
    await ensureReady($).catch(() => undefined)
    const started = await next(e)
    if (started.deny === undefined && memberOf(e.subagentType)) {
      await recordStart($, e, started).catch(() => undefined)
    }
    return started
  })

  // Each model request of a crew agent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId && usage) {
      await recordStep($, e.agentId, usage.model || e.model, usage).catch(() => undefined)
    }
    return result
  })

  // A crew agent's turn ends: mark its run done or failed.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await recordEnd($, e.agentId, e.reason === 'answer' ? 'done' : 'failed', e.usage).catch(() => undefined)
    }
    return next(e)
  })

  // ------------------------------------------------------------------ the My agents pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const p = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    const running = list.filter(a => a.status === 'running').reverse()
    const latest = new Set((batchesOf(list).at(-1) ?? []).map(a => a.id))
    const finished = list.filter(a => a.status !== 'running' && latest.has(a.id)).reverse()
    const earlier = list.filter(a => a.status !== 'running' && !latest.has(a.id)).reverse()
    const busy = new Set(running.map(a => a.type))
    const countOf = (type: string) => list.filter(a => a.type === type && a.status !== 'running').length
    const t = totals(list, at)
    const isEmpty = list.length === 0

    // The small corner form on the desktop app: just the lineup.
    if (e.props.placement === 'widget') {
      if (e.surface === 'desktop' && 'Svg' in ui) {
        const { Svg } = ui
        return <Svg source={lineupSvg(CREW.length * 36, busy, false)} alt={`${running.length} of your agents working`} width={CREW.length * 36} height={LINEUP_H} />
      }
      return (
        <Text>
          {CREW.map(m => (
            <Text key={m.type} color={m.color} dimColor={!busy.has(m.type)} bold={busy.has(m.type)}>
              {m.glyph}{' '}
            </Text>
          ))}
        </Text>
      )
    }

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? 'Expand' : 'Collapse'}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleCrew = (
      <Button
        key="crew"
        label={`${p.isCrewOpen ? '▾' : '▸'} Crew · ${CREW.length}${busy.size ? ` · ${busy.size} working` : ''}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCrewOpen: !prev.isCrewOpen }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const toggleEarlier = (
      <Button
        key="earlier"
        label={`${p.isEarlierOpen ? '▾' : '▸'} Earlier · ${earlier.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isEarlierOpen: !prev.isEarlierOpen }))}
      />
    )
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} tokens, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )
      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, t)} alt={`${list.length} agent runs, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const shownDone = (p.isDoneCollapsed ? 0 : finished.length) + (p.isEarlierOpen ? earlier.length : 0)
      const crewRows = p.isCrewOpen ? CREW.length : 0
      const lines = 2 + (isEmpty ? 1 : 0) + (running.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0) + (earlier.length > 0 ? 1 : 0)
      const gridH = HEADER_H + lineupHeight(W) + lines * LINE_H + crewRows * CREW_ROW_H + (running.length + shownDone) * ROW_H
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is placed over it. */}
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <Svg source={headerSvg(W, t)} alt={summary} width={W} height={HEADER_H} />
            <Svg source={lineupSvg(W, busy)} alt={`Crew: ${CREW.map(m => `${m.label}${busy.has(m.type) ? ' (working)' : ''}`).join(', ')}`} width={W} height={lineupHeight(W)} />
            {toggleCrew}
            {p.isCrewOpen &&
              CREW.map(m => (
                <Svg key={`crew-${m.type}`} source={crewRowSvg(W, m, busy.has(m.type), countOf(m.type))} alt={`${m.label}: ${m.role}`} width={W} height={CREW_ROW_H} />
              ))}
            {toggleCompact}
            {isEmpty && <Text dimColor>No agent runs yet in this session.</Text>}
            {running.length > 0 && section('h-run', `Running · ${running.length}`)}
            {running.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${memberOf(a.type)?.label ?? a.type}, ${modelName(a.model)}, running`} width={W} height={ROW_H} />
            ))}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed &&
              finished.map(a => (
                <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${memberOf(a.type)?.label ?? a.type}, ${modelName(a.model)}, ${a.status}`} width={W} height={ROW_H} />
              ))}
            {earlier.length > 0 && toggleEarlier}
            {p.isEarlierOpen &&
              earlier.map(a => (
                <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${memberOf(a.type)?.label ?? a.type}, ${modelName(a.model)}, ${a.status}`} width={W} height={ROW_H} />
              ))}
          </Box>
        </Box>
      )
    }

    // Terminal: the same content in text rows, each agent by its own shape.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const m = memberOf(a.type)
      const color = colorOf(a.type)
      const ctx = ctxOf(a)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color} bold>
              {m?.glyph ?? '▣'}
            </Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {m?.label ?? a.type} · {modelName(a.model)}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {a.status === 'done' ? <Text color={color}>{ctxBar(100, barW)}</Text> : <Text dimColor>{ctxBar(ctx, barW)}</Text>}
            <Text dimColor>
              {' '}
              ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} tokens · {fmtTime(t.time)}
          </Text>
          {toggleCompact}
        </Box>
        <Text>
          {CREW.map(m => (
            <Text key={m.type} color={m.color} dimColor={!busy.has(m.type)} bold={busy.has(m.type)}>
              {m.glyph}{' '}
            </Text>
          ))}
        </Text>
        {toggleCrew}
        {p.isCrewOpen &&
          CREW.map(m => (
            <Text key={`crew-${m.type}`} wrap="truncate-end">
              <Text color={m.color} bold>
                {m.glyph}
              </Text>{' '}
              <Text bold={busy.has(m.type)} dimColor={!busy.has(m.type)}>
                {m.label}
              </Text>
              <Text dimColor>
                {'  '}
                {busy.has(m.type) ? 'working…' : countOf(m.type) ? `${countOf(m.type)} run${countOf(m.type) === 1 ? '' : 's'}` : m.role}
              </Text>
            </Text>
          ))}
        {!p.isCompact && (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>No agent runs yet in this session.</Text>}
            {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {earlier.length > 0 && toggleEarlier}
            {p.isEarlierOpen && earlier.map(row)}
          </Box>
        )}
      </Box>
    )
  })

  // ------------------------------------------------------------------ the bar above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, batch)
    if (b === null || e.props.hasSurvey) return next(e)
    const list = await read($, runs)
    if (!b.ids.some(id => list.some(r => r.id === id))) return next(e)
    // Draw this row with the other mods' bands beneath it. Claude Code's own placeholder
    // ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const s = barOf(b, list)
    const percent = `${Math.round(ratio(s) * 100)}%`
    const crewButton = <Button key="crew-agents" label={`×${CREW.length}`} plain onPress={() => void togglePane($)} />
    const dismiss = <Button key="crew-dismiss" label="✕" plain role="dismiss" onPress={() => update($, batch, () => null)} />

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // bodyColumns only estimates the row's pixel width, so the drawing gets no fixed size: it
      // scales down to whatever the buttons leave, and the buttons never shrink off the edge.
      // 140 px leaves room for the ×7 and ✕ buttons and their gaps at the estimated width.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 140))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box key="crew-bar-drawing" flexShrink={1} minWidth={0}>
              <Svg source={barSvg(s, width)} alt={`${TITLE}: ${barLabel(s)}, ${percent}`} />
            </Box>
            <Box key="crew-bar-buttons" flexDirection="row" alignItems="center" flexShrink={0}>
              {crewButton}
              {dismiss}
            </Box>
          </Box>
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.min(12, Math.floor(cols / 3))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    const latest = memberOf(s.costume)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={s.isFinished ? DONE : ACCENT}>● </Text>
            <Text wrap="truncate-end">{TITLE}</Text>
          </Box>
          <Text color={s.isFinished ? DONE : ACCENT}>{barText(s, width)}</Text>
          <Text bold>{barLabel(s)}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={latest?.color ?? CLAY}>{latest?.glyph ?? '▣'}</Text>
          {crewButton}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}

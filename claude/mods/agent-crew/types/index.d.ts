export type RunStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  /** The started agent's id when known, else the Agent tool call's id. */
  id: string
  agentId?: string
  /** One of the crew's agent names, e.g. "code-reviewer". */
  type: string
  description: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  model: string
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  isCrewOpen: boolean
}

/** The runs the progress bar above the prompt counts: from the first start until all finish. */
export type Batch = {
  ids: string[]
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-crew': {
      runs: Shaped<AgentRun[]>
      panel: Panel
      now: number
      batch: Batch | null
    }
  }
}

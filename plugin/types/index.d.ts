export type Tab = 'issues' | 'prs' | 'milestones' | 'session'

export type Checks = 'pass' | 'fail' | 'pending' | 'none'

export type Issue = {
  number: number
  title: string
  url: string
  labels: string[]
  assignees: string[]
  updatedAt: string
}

export type Pr = {
  number: number
  title: string
  url: string
  author: string
  isDraft: boolean
  checks: Checks
  review: string
  updatedAt: string
}

export type Milestone = {
  number: number
  title: string
  description: string
  url: string
  open: number
  closed: number
  dueOn: string | null
}

export type MilestoneIssue = {
  number: number
  title: string
  url: string
  isOpen: boolean
  labels: string[]
  assignees: string[]
  updatedAt: string
  closedAt: string | null
}

/** A milestone opened from the Milestones tab, with its issues. */
export type MilestoneView = Milestone & {
  repo: string
  issues: MilestoneIssue[]
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
}

export type Snapshot = {
  repo: string | null
  issues: Issue[]
  prs: Pr[]
  milestones: Milestone[]
  fetchedAt: number | null
  error: string | null
  isLoading: boolean
}

export type CheckResult = 'pass' | 'fail' | 'pending' | 'skip'

/** One check of a PR. GitHub Actions jobs carry their workflow and run; other apps' checks don't. */
export type CheckRow = {
  name: string
  result: CheckResult
  workflow: string
  runId: number | null
  startedAt: string | null
  completedAt: string | null
}

export type RunJob = {
  id: number
  name: string
  result: CheckResult
  startedAt: string | null
  completedAt: string | null
  /** Names of the steps that failed. */
  failedSteps: string[]
  /** Last lines of the failed log, up to the error; null until loaded. */
  log: string[] | null
  logError: string | null
}

/** A GitHub Actions workflow run opened from a PR's CI section. */
export type RunView = {
  repo: string
  runId: number
  name: string
  number: number
  attempt: number
  branch: string
  event: string
  /** gh's queued / in_progress / completed. */
  status: string
  result: CheckResult
  url: string
  startedAt: string | null
  updatedAt: string | null
  jobs: RunJob[]
  rerun: 'idle' | 'confirm' | 'sending'
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
}

export type ReviewRow = { author: string; state: string }

/** What the pane shows instead of a list: one issue or one PR. */
export type Detail = {
  kind: 'issue' | 'pr'
  repo: string
  number: number
  title: string
  url: string
  body: string
  state: string
  author: string
  labels: string[]
  assignees: string[]
  createdAt: string
  comments: number
  // PR only
  isDraft: boolean
  branch: string
  base: string
  review: string
  checks: CheckRow[]
  reviews: ReviewRow[]
  additions: number
  deletions: number
  files: number
  mergedAt: string | null
  mergedBy: string
  closedAt: string | null
  /** gh's MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeable: string
  /** gh's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeState: string
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
}

/** A PR linked to this session, as tokephobia's status line found it in the transcript. */
export type SessionPr = {
  number: number
  url: string
  repo: string
  created: boolean
  state: string | null
  isDraft: boolean
  checks: Checks | null
}

declare module 'claude-code' {
  interface PluginState {
    'tokephobia': {
      tab: Shaped<Tab>
      data: Shaped<Snapshot>
      /** `owner/repo` chosen with `/gh owner/repo`; null follows the session's folder. */
      repo: Shaped<string | null>
      /** Category the pane shows alone (opened from the band); null shows every tab (/gh). */
      solo: Shaped<Tab | null>
      /** Issue or PR the pane shows instead of the list; null shows the list. */
      detail: Shaped<Detail | null>
      /** PRs of this session, shown as buttons on the band. */
      sessionPrs: Shaped<SessionPr[]>
      /** Workflow run the pane shows on top of a PR's detail; null shows the PR. */
      run: Shaped<RunView | null>
      /** Milestone the pane shows instead of the Milestones list; null shows the list. */
      milestone: Shaped<MilestoneView | null>
    }
  }
}

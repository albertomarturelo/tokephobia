import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderChildren } from 'claude-code'

import type { CheckResult, CheckRow, Checks, Detail, Issue, MergeMethod, Milestone, MilestoneIssue, MilestoneView, Pr, ReviewRow, RunJob, RunView, SessionPr, Snapshot, Tab } from '../types'

/** The `$` every hook receives. */
type Dollar = Parameters<Hook<'session.start'>>[0]

const PANE = 'gh'
const REFRESH_MS = 2 * 60_000
const SESSION_PRS_MS = 15_000
/** How often an open workflow run (every tick) or a PR with running checks (every other tick) refreshes. */
const LIVE_MS = 10_000
const LOG_LINES = 12
/** Session PRs shown on the band; the rest are behind a "+N" that opens the Session tab. */
const BAND_PRS = 4
const LIMIT = 30

const EMPTY: Snapshot = {
  repo: null,
  issues: [],
  prs: [],
  milestones: [],
  fetchedAt: null,
  error: null,
  isLoading: false,
}

const tab = atom({ plugin: 'tokephobia', key: 'tab' } as const, 'prs' as Tab, { shape: 'tab-2' })
const data = atom({ plugin: 'tokephobia', key: 'data' } as const, EMPTY, { shape: 'data-2' })
const solo = atom({ plugin: 'tokephobia', key: 'solo' } as const, null as Tab | null, { shape: 'solo-2' })
const detail = atom({ plugin: 'tokephobia', key: 'detail' } as const, null as Detail | null, { shape: 'detail-5' })
const sessionPrs = atom({ plugin: 'tokephobia', key: 'sessionPrs' } as const, [] as SessionPr[], { shape: 'session-prs-1' })
const run = atom({ plugin: 'tokephobia', key: 'run' } as const, null as RunView | null, { shape: 'run-1' })
const shownMilestone = atom({ plugin: 'tokephobia', key: 'milestone' } as const, null as MilestoneView | null, { shape: 'milestone-1' })
const repoChoice = atom({ plugin: 'tokephobia', key: 'repo' } as const, null as string | null, { shape: 'repo-1' })

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'issues', label: 'Issues', hotkey: '1' },
  { id: 'prs', label: 'Pull requests', hotkey: '2' },
  { id: 'milestones', label: 'Milestones', hotkey: '3' },
  { id: 'session', label: 'Session', hotkey: '4' },
]

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

function checkRow(c: Record<string, unknown>): CheckRow {
  const conclusion = String(c.conclusion ?? '').toUpperCase()
  const state = String(c.state ?? '').toUpperCase()
  const status = String(c.status ?? '').toUpperCase()
  const row = {
    name: String(c.name ?? c.context ?? 'check'),
    workflow: String(c.workflowName ?? ''),
    // Actions jobs link to .../actions/runs/<run id>/job/<job id>.
    runId: Number(/\/actions\/runs\/(\d+)/.exec(String(c.detailsUrl ?? ''))?.[1]) || null,
    startedAt: (c.startedAt as string) || null,
    completedAt: (c.completedAt as string) || null,
  }
  if (FAILED.has(conclusion) || state === 'FAILURE' || state === 'ERROR') return { ...row, result: 'fail' }
  if (status ? status !== 'COMPLETED' : state === 'PENDING' || state === 'EXPECTED') return { ...row, result: 'pending' }
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return { ...row, result: 'skip' }
  return { ...row, result: 'pass' }
}

/** Result of an Actions job or run, from gh's lowercase status and conclusion. */
function actionsResult(status: unknown, conclusion: unknown): CheckResult {
  if (String(status ?? '').toLowerCase() !== 'completed') return 'pending'
  const c = String(conclusion ?? '').toUpperCase()
  if (FAILED.has(c)) return 'fail'
  if (c === 'SKIPPED' || c === 'NEUTRAL') return 'skip'
  return 'pass'
}

export type WorkflowGroup = {
  runId: number
  name: string
  result: CheckResult
  total: number
  failed: number
  done: number
  startedAt: string | null
  completedAt: string | null
}

/** Groups a PR's Actions jobs by run; checks from other apps are returned apart. */
export function groupWorkflows(checks: CheckRow[]): { workflows: WorkflowGroup[]; others: CheckRow[] } {
  const byRun = new Map<number, CheckRow[]>()
  const others: CheckRow[] = []
  for (const c of checks) {
    if (c.runId) byRun.set(c.runId, [...(byRun.get(c.runId) ?? []), c])
    else others.push(c)
  }
  const workflows = [...byRun].map(([runId, jobs]): WorkflowGroup => {
    const failed = jobs.filter(j => j.result === 'fail').length
    const pending = jobs.filter(j => j.result === 'pending').length
    const starts = jobs.map(j => j.startedAt).filter(Boolean).sort() as string[]
    const ends = jobs.map(j => j.completedAt).filter(Boolean).sort() as string[]
    return {
      runId,
      name: jobs[0]!.workflow || jobs[0]!.name,
      result: failed ? 'fail' : pending ? 'pending' : jobs.every(j => j.result === 'skip') ? 'skip' : 'pass',
      total: jobs.length,
      failed,
      done: jobs.length - pending,
      startedAt: starts[0] ?? null,
      completedAt: pending ? null : ends[ends.length - 1] ?? null,
    }
  })
  const order: CheckResult[] = ['fail', 'pending', 'pass', 'skip']
  workflows.sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result))
  return { workflows, others }
}

/** "41s", "4m 12s", "1h 5m". */
export function duration(from: string | null, to: string | number | null): string {
  if (!from || to === null) return ''
  const ms = (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from)
  if (!(ms >= 0)) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

/**
 * The end of a failed job's log: up to the last `##[error]` line, without
 * gh's "job<TAB>step<TAB>timestamp" prefix or terminal colors.
 */
export function logTail(raw: string, max = LOG_LINES): string[] {
  const lines = raw.split('\n').map(line => {
    const text = line.split('\t').slice(2).join('\t') || line
    return text.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
  }).filter(l => l.trim())
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.includes('##[error]')) { end = i + 1; break }
  return lines.slice(Math.max(0, end - max), end).map(l => l.replace('##[error]', ''))
}

function summarizeChecks(rollup: unknown): Checks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  const rows = (rollup as Array<Record<string, unknown>>).map(checkRow)
  if (rows.some(r => r.result === 'fail')) return 'fail'
  if (rows.some(r => r.result === 'pending')) return 'pending'
  return 'pass'
}

function ago(iso: string | null, now: number): string {
  if (!iso) return ''
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 60) return `${min}m`
  if (min < 48 * 60) return `${Math.round(min / 60)}h`
  return `${Math.round(min / 1440)}d`
}

function dueLabel(iso: string | null): string {
  if (!iso) return 'no due date'
  const d = new Date(iso)
  return `due ${new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(d)} ${d.getUTCDate()}`
}

/** Same file-name rule as tokephobia's status line cache. */
function safeKey(s: string): string {
  return s.replace(/[^\w.-]/g, '_')
}

// Module variables start over on every reload; session.start sets them again.
let cwd: string | undefined
let cacheDir: string | undefined
let isRefreshing = false
let isPaneOpen = false
let liveTick = 0

async function gh($: Dollar, args: string[]): Promise<any> {
  const r = await $.process.run(['gh', ...args], { cwd, timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout || `gh exited with ${r.exitCode}`).trim().split('\n')[0])
  return JSON.parse(r.stdout)
}

async function refresh($: Dollar): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  await update($, data, d => ({ ...d, isLoading: true }))
  try {
    const repo: string =
      (await read($, repoChoice)) ?? (await gh($, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner
    const [issues, prs, milestones] = await Promise.all([
      gh($, ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIMIT),
        '--json', 'number,title,url,labels,assignees,updatedAt']),
      gh($, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIMIT),
        '--json', 'number,title,url,author,isDraft,statusCheckRollup,reviewDecision,updatedAt']),
      gh($, ['api', `repos/${repo}/milestones?state=open&sort=due_on&direction=asc&per_page=${LIMIT}`]),
    ])
    const snapshot: Snapshot = {
      repo,
      issues: issues.map((i: any): Issue => ({
        number: i.number,
        title: i.title,
        url: i.url,
        labels: (i.labels ?? []).map((l: any) => l.name),
        assignees: (i.assignees ?? []).map((a: any) => a.login),
        updatedAt: i.updatedAt,
      })),
      prs: prs.map((p: any): Pr => ({
        number: p.number,
        title: p.title,
        url: p.url,
        author: p.author?.login ?? '',
        isDraft: Boolean(p.isDraft),
        checks: summarizeChecks(p.statusCheckRollup),
        review: p.reviewDecision ?? '',
        updatedAt: p.updatedAt,
      })),
      milestones: milestones.map((m: any): Milestone => ({
        number: m.number,
        title: m.title,
        description: m.description ?? '',
        url: m.html_url,
        open: m.open_issues,
        closed: m.closed_issues,
        dueOn: m.due_on,
      })),
      fetchedAt: await $.clock.now(),
      error: null,
      isLoading: false,
    }
    await update($, data, () => snapshot)
  } catch (err) {
    await update($, data, d => ({ ...d, error: (err as Error).message, isLoading: false }))
  } finally {
    isRefreshing = false
  }
}

async function readJson($: Dollar, path: string): Promise<any> {
  try {
    const raw: unknown = await $.fs.read(path)
    return JSON.parse(typeof raw === 'string' ? raw : String((raw as any)?.text ?? ''))
  } catch {
    return undefined
  }
}

/**
 * The session's PRs come from tokephobia's status line, which scans this
 * session's transcript and caches what it finds (and each PR's state/CI).
 */
/** Session PRs order everywhere: open first, then the ones the session created, then the newest. */
export function bySessionOrder(a: SessionPr, b: SessionPr): number {
  const isDone = (p: SessionPr) => p.state === 'MERGED' || p.state === 'CLOSED'
  return Number(isDone(a)) - Number(isDone(b)) || Number(b.created) - Number(a.created) || b.number - a.number
}

async function loadSessionPrs($: Dollar): Promise<void> {
  if (!cacheDir) {
    const r = await $.process.run(['sh', '-c', 'printf %s "${TOKEPHOBIA_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tokephobia}"'])
    cacheDir = r.stdout.trim() || undefined
    if (!cacheDir) return
  }
  const id = await $.session.id()
  const state = await readJson($, `${cacheDir}/sessions/${safeKey(String(id))}.json`)
  const prs: any[] = Array.isArray(state?.prs) ? state.prs : []
  const list: SessionPr[] = []
  for (const p of prs) {
    const status = await readJson($, `${cacheDir}/prs/${safeKey(p.repo)}__${p.number}.json`)
    list.push({
      number: p.number,
      url: p.url,
      repo: p.repo,
      created: Boolean(p.created),
      state: status?.state ?? null,
      isDraft: Boolean(status?.draft),
      checks: status?.checks ?? null,
    })
  }
  list.sort(bySessionOrder)
  const before = await read($, sessionPrs)
  if (JSON.stringify(before) !== JSON.stringify(list)) await update($, sessionPrs, () => list)
}

function emptyDetail(kind: Detail['kind'], repo: string, number: number, title: string, url: string): Detail {
  return {
    kind, repo, number, title, url, body: '', state: '', author: '', labels: [], assignees: [], createdAt: '',
    comments: 0, isDraft: false, branch: '', base: '', review: '', checks: [], reviews: [],
    additions: 0, deletions: 0, files: 0, mergedAt: null, mergedBy: '', closedAt: null, mergeable: '', mergeState: '',
    merge: 'idle', mergeMethods: [], canBypass: false, bypass: false,
    isLoading: true, isRefreshing: false, error: null,
  }
}

async function showInPane($: Dollar, kind: Tab, title: string): Promise<void> {
  await update($, solo, () => kind)
  await update($, tab, () => kind)
  await $.ui.open({ id: PANE, title })
  isPaneOpen = true
}

async function openIssue($: Dollar, repo: string, issue: { number: number; title: string; url: string }, keep = false): Promise<void> {
  const base = emptyDetail('issue', repo, issue.number, issue.title, issue.url)
  if (keep) await update($, detail, d => (d ? { ...d, isRefreshing: true } : d))
  else {
    await update($, run, () => null)
    await update($, detail, () => base)
  }
  try {
    const i = await gh($, ['issue', 'view', String(issue.number), '--repo', repo,
      '--json', 'number,title,url,body,state,author,labels,assignees,createdAt,comments'])
    await update($, detail, d => (d?.kind !== 'issue' || d.number !== issue.number ? d : {
      ...base,
      title: i.title,
      body: i.body ?? '',
      state: i.state,
      author: i.author?.login ?? '',
      labels: (i.labels ?? []).map((l: any) => l.name),
      assignees: (i.assignees ?? []).map((a: any) => a.login),
      createdAt: i.createdAt,
      comments: Array.isArray(i.comments) ? i.comments.length : 0,
      isLoading: false,
    }))
  } catch (err) {
    if (keep) await refreshFailed($, err)
    else await update($, detail, d => (d?.number !== issue.number ? d : { ...base, isLoading: false, error: (err as Error).message }))
  }
}

async function openPr($: Dollar, repo: string, pr: { number: number; title?: string; url: string }, keep = false): Promise<void> {
  const base = emptyDetail('pr', repo, pr.number, pr.title ?? '', pr.url)
  if (keep) await update($, detail, d => (d ? { ...d, isRefreshing: true } : d))
  else {
    await update($, run, () => null)
    await update($, detail, () => base)
  }
  try {
    const p = await gh($, ['pr', 'view', String(pr.number), '--repo', repo, '--json',
      'number,title,url,body,state,isDraft,author,labels,assignees,createdAt,comments,headRefName,baseRefName,reviewDecision,statusCheckRollup,reviews,additions,deletions,changedFiles,mergedAt,mergedBy,closedAt,mergeable,mergeStateStatus'])
    // Latest review per reviewer.
    const latest = new Map<string, ReviewRow>()
    for (const r of p.reviews ?? []) latest.set(r.author?.login ?? '?', { author: r.author?.login ?? '?', state: r.state })
    await update($, detail, d => (d?.kind !== 'pr' || d.number !== pr.number ? d : {
      ...base,
      title: p.title,
      body: p.body ?? '',
      state: p.state,
      isDraft: Boolean(p.isDraft),
      author: p.author?.login ?? '',
      labels: (p.labels ?? []).map((l: any) => l.name),
      assignees: (p.assignees ?? []).map((a: any) => a.login),
      createdAt: p.createdAt,
      comments: Array.isArray(p.comments) ? p.comments.length : 0,
      branch: p.headRefName ?? '',
      base: p.baseRefName ?? '',
      review: p.reviewDecision ?? '',
      checks: (p.statusCheckRollup ?? []).map(checkRow),
      reviews: [...latest.values()],
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      files: p.changedFiles ?? 0,
      mergedAt: p.mergedAt || null,
      mergedBy: p.mergedBy?.login ?? '',
      closedAt: p.closedAt || null,
      mergeable: p.mergeable ?? '',
      mergeState: p.mergeStateStatus ?? '',
      isLoading: false,
    }))
  } catch (err) {
    if (keep) await refreshFailed($, err)
    else await update($, detail, d => (d?.number !== pr.number ? d : { ...base, isLoading: false, error: (err as Error).message }))
  }
}

async function openMilestone($: Dollar, repo: string, m: Milestone): Promise<void> {
  const loading: MilestoneView = { ...m, repo, issues: [], isLoading: true, isRefreshing: false, error: null }
  await update($, shownMilestone, () => loading)
  await loadMilestone($)
}

/** Loads the open milestone's issues (open and closed) and its latest counts. */
async function loadMilestone($: Dollar): Promise<void> {
  const current = await read($, shownMilestone)
  if (!current) return
  const { repo, number } = current
  if (!current.isLoading) await update($, shownMilestone, v => (v?.number === number ? { ...v, isRefreshing: true } : v))
  try {
    const [m, issues] = await Promise.all([
      gh($, ['api', `repos/${repo}/milestones/${number}`]),
      gh($, ['issue', 'list', '--repo', repo, '--milestone', String(number), '--state', 'all', '--limit', '200',
        '--json', 'number,title,url,state,labels,assignees,updatedAt,closedAt']),
    ])
    await update($, shownMilestone, v => (v?.number !== number ? v : {
      ...v,
      title: m.title ?? v.title,
      description: m.description ?? '',
      open: m.open_issues ?? v.open,
      closed: m.closed_issues ?? v.closed,
      dueOn: m.due_on ?? null,
      url: m.html_url ?? v.url,
      issues: issues.map((i: any): MilestoneIssue => ({
        number: i.number,
        title: i.title,
        url: i.url,
        isOpen: String(i.state).toUpperCase() === 'OPEN',
        labels: (i.labels ?? []).map((l: any) => l.name),
        assignees: (i.assignees ?? []).map((a: any) => a.login),
        updatedAt: i.updatedAt,
        closedAt: i.closedAt || null,
      })),
      isLoading: false,
      isRefreshing: false,
      error: null,
    }))
  } catch (err) {
    const message = (err as Error).message
    await update($, shownMilestone, v => (v?.number !== number ? v : v.isLoading ? { ...v, isLoading: false, error: message } : { ...v, isRefreshing: false }))
    if (!current.isLoading) await $.ui.toast(`Couldn't refresh the milestone: ${message}`)
  }
}

/** Opens a URL in the browser (macOS `open`, else `xdg-open`). */
async function openUrl($: Dollar, url: string): Promise<void> {
  const r = await $.process.run(['sh', '-c', 'if command -v open >/dev/null 2>&1; then open "$1"; else xdg-open "$1"; fi', 'sh', url], { timeoutMs: 15_000 })
  if (r.exitCode !== 0) await $.ui.toast(`Couldn't open ${url}`)
}

const MERGE_METHODS: { id: MergeMethod; flag: string; label: string; hotkey: string; allowed: string }[] = [
  { id: 'squash', flag: '--squash', label: 'Squash and merge', hotkey: 's', allowed: 'squashMergeAllowed' },
  { id: 'merge', flag: '--merge', label: 'Merge commit', hotkey: 'c', allowed: 'mergeCommitAllowed' },
  { id: 'rebase', flag: '--rebase', label: 'Rebase and merge', hotkey: 'e', allowed: 'rebaseMergeAllowed' },
]

/** First press of Merge: asks which method, offering only those the repo allows. */
async function askMerge($: Dollar): Promise<void> {
  const d = await read($, detail)
  if (d?.kind !== 'pr' || d.merge !== 'idle') return
  await update($, detail, x => (x ? { ...x, merge: 'confirm' as const, bypass: false } : x))
  try {
    const repo = await gh($, ['repo', 'view', d.repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerPermission'])
    const methods = MERGE_METHODS.filter(m => repo[m.allowed] !== false).map(m => m.id)
    const canBypass = String(repo.viewerPermission ?? '').toUpperCase() === 'ADMIN'
    await update($, detail, x => (x?.number === d.number ? { ...x, mergeMethods: methods, canBypass } : x))
  } catch {
    await update($, detail, x => (x?.number === d.number ? { ...x, mergeMethods: MERGE_METHODS.map(m => m.id) } : x))
  }
}

/** `gh pr merge` with the method the person picked; then shows the PR as merged. */
async function mergePr($: Dollar, method: MergeMethod): Promise<void> {
  const d = await read($, detail)
  if (d?.kind !== 'pr' || d.merge !== 'confirm') return
  await update($, detail, x => (x ? { ...x, merge: 'sending' as const } : x))
  const flag = MERGE_METHODS.find(m => m.id === method)!.flag
  const argv = ['gh', 'pr', 'merge', String(d.number), '--repo', d.repo, flag, ...(d.canBypass && d.bypass ? ['--admin'] : [])]
  const r = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
  if (r.exitCode !== 0) {
    await update($, detail, x => (x ? { ...x, merge: 'confirm' as const } : x))
    const why = (r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`
    await $.ui.toast(`Couldn't merge #${d.number}: ${why}${d.canBypass && !d.bypass ? ' (as an admin you can turn on the bypass)' : ''}`)
    return
  }
  await $.ui.toast(`Merged #${d.number} into ${d.base || 'the base branch'}`)
  await openPr($, d.repo, d, true)
  void refresh($)
}

/** A refresh that fails keeps what is shown and says why. */
async function refreshFailed($: Dollar, err: unknown): Promise<void> {
  await update($, detail, d => (d ? { ...d, isRefreshing: false } : d))
  await $.ui.toast(`Couldn't refresh: ${(err as Error).message}`)
}

/** Reloads the issue or PR on screen without blanking it. */
async function refreshDetail($: Dollar): Promise<void> {
  const d = await read($, detail)
  if (!d || d.isLoading || d.isRefreshing) return
  if (d.kind === 'pr') await openPr($, d.repo, d, true)
  else await openIssue($, d.repo, d, true)
}

async function openRun($: Dollar, repo: string, runId: number, name: string): Promise<void> {
  const loading: RunView = {
    repo, runId, name, number: 0, attempt: 1, branch: '', event: '', status: '', result: 'pending', url: '',
    startedAt: null, updatedAt: null, jobs: [], rerun: 'idle', isLoading: true, isRefreshing: false, error: null,
  }
  await update($, run, () => loading)
  await loadRun($)
}

/** Loads the open run's jobs, then the log of each failed job (up to 3). */
async function loadRun($: Dollar): Promise<void> {
  const current = await read($, run)
  if (!current) return
  const { repo, runId } = current
  if (!current.isLoading) await update($, run, r => (r?.runId === runId ? { ...r, isRefreshing: true } : r))
  try {
    const r = await gh($, ['run', 'view', String(runId), '--repo', repo, '--json',
      'name,workflowName,status,conclusion,number,attempt,headBranch,event,startedAt,updatedAt,url,jobs'])
    let fresh: RunView | null = null
    await update($, run, prev => {
      if (prev?.runId !== runId) return prev
      const oldJobs = new Map(prev.jobs.map(j => [j.id, j]))
      const jobs = (r.jobs ?? []).map((j: any): RunJob => {
        const result = actionsResult(j.status, j.conclusion)
        const old = oldJobs.get(j.databaseId)
        // A job keeps its log while it is still the same failure.
        const keepLog = old && old.result === 'fail' && result === 'fail' && old.completedAt === (j.completedAt || null)
        return {
          id: j.databaseId,
          name: j.name,
          result,
          startedAt: j.startedAt || null,
          completedAt: j.status === 'completed' ? j.completedAt || null : null,
          failedSteps: (j.steps ?? []).filter((st: any) => FAILED.has(String(st.conclusion ?? '').toUpperCase())).map((st: any) => st.name),
          log: keepLog ? old.log : null,
          logError: keepLog ? old.logError : null,
        }
      })
      fresh = {
        ...prev,
        name: r.workflowName || r.name || prev.name,
        number: r.number ?? 0,
        attempt: r.attempt ?? 1,
        branch: r.headBranch ?? '',
        event: r.event ?? '',
        status: String(r.status ?? '').toLowerCase(),
        result: actionsResult(r.status, r.conclusion),
        url: r.url ?? '',
        startedAt: r.startedAt || null,
        updatedAt: r.updatedAt || null,
        jobs,
        isLoading: false,
        isRefreshing: false,
        error: null,
      }
      return fresh
    })
    const needLogs = ((fresh as RunView | null)?.jobs ?? []).filter(j => j.result === 'fail' && !j.log && !j.logError).slice(0, 3)
    await Promise.all(needLogs.map(j => loadJobLog($, repo, runId, j.id)))
  } catch (err) {
    const message = (err as Error).message
    await update($, run, r => (r?.runId !== runId ? r : r.isLoading ? { ...r, isLoading: false, error: message } : { ...r, isRefreshing: false }))
    if (!current.isLoading) await $.ui.toast(`Couldn't refresh the run: ${message}`)
  }
}

async function loadJobLog($: Dollar, repo: string, runId: number, jobId: number): Promise<void> {
  const r = await $.process.run(['gh', 'run', 'view', '--job', String(jobId), '--repo', repo, '--log-failed'], { cwd, timeoutMs: 60_000 })
  const log = r.exitCode === 0 ? logTail(r.stdout) : null
  const logError = r.exitCode === 0 ? (log!.length ? null : 'the log is empty') : (r.stderr || r.stdout).trim().split('\n')[0] || 'log not available'
  await update($, run, v => (v?.runId !== runId ? v : {
    ...v,
    jobs: v.jobs.map(j => (j.id === jobId ? { ...j, log: log?.length ? log : null, logError } : j)),
  }))
}

/** `gh run rerun --failed`: starts the failed jobs again. Only after the person confirmed. */
async function rerunFailed($: Dollar): Promise<void> {
  const v = await read($, run)
  if (!v || v.rerun !== 'confirm') return
  await update($, run, r => (r ? { ...r, rerun: 'sending' as const } : r))
  const r = await $.process.run(['gh', 'run', 'rerun', String(v.runId), '--failed', '--repo', v.repo], { cwd, timeoutMs: 30_000 })
  await update($, run, x => (x ? { ...x, rerun: 'idle' as const } : x))
  if (r.exitCode !== 0) {
    await $.ui.toast(`Couldn't re-run: ${(r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`}`)
    return
  }
  await $.ui.toast(`Re-running the failed jobs of ${v.name} #${v.number}`)
  await loadRun($)
}

/** Keeps what the pane shows current while CI runs. */
async function liveRefresh($: Dollar): Promise<void> {
  if (!isPaneOpen) return
  liveTick++
  const v = await read($, run)
  if (v) {
    if (!v.isLoading && !v.isRefreshing && v.status !== 'completed') await loadRun($)
    return
  }
  const d = await read($, detail)
  if (d?.kind === 'pr' && liveTick % 2 === 0 && d.checks.some(c => c.result === 'pending')) await refreshDetail($)
}

async function openWeb($: Dollar, argv: string[], what: string): Promise<void> {
  const r = await $.process.run(['gh', ...argv, '--web'], { cwd, timeoutMs: 15_000 })
  if (r.exitCode !== 0) await $.ui.toast(`Couldn't open ${what}: ${(r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`}`)
}

/**
 * Opens an issue or PR in the browser through `gh ... --web`, which knows how
 * to open a browser on every OS. A Link alone only works where the terminal
 * supports clickable links, and never from the keyboard.
 */
async function openOnGitHub($: Dollar, item: Detail): Promise<void> {
  const r = await $.process.run(['gh', item.kind, 'view', String(item.number), '--repo', item.repo, '--web'], { cwd, timeoutMs: 15_000 })
  if (r.exitCode !== 0) await $.ui.toast(`Couldn't open #${item.number}: ${(r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'gh',
      description: 'GitHub pane (issues, PRs, milestones, session PRs). /gh owner/repo switches repo; /gh auto goes back to the session repo',
    })
    void refresh($)
    void loadSessionPrs($)
    $.clock.every(REFRESH_MS, () => refresh($))
    $.clock.every(SESSION_PRS_MS, () => loadSessionPrs($))
    $.clock.every(LIVE_MS, () => liveRefresh($))
    return next(e)
  })

  on('command.run', { command: 'gh' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'auto') await update($, repoChoice, () => null)
    else if (/^[\w.-]+\/[\w.-]+$/.test(arg)) await update($, repoChoice, () => arg)
    else if (arg) return { text: 'Usage: /gh [owner/repo | auto]' }
    if (arg) await update($, data, () => EMPTY)
    void refresh($)
    await update($, run, () => null)
    await update($, detail, () => null)
    await update($, shownMilestone, () => null)
    await update($, solo, () => null)
    await $.ui.open({ id: PANE, title: 'GitHub' })
    isPaneOpen = true
    return { text: arg ? `GitHub pane: ${arg === 'auto' ? 'session repo' : arg}` : 'GitHub pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      await update($, run, () => null)
      await update($, shownMilestone, () => null)
      await update($, detail, () => null)
      await update($, solo, () => null) // redraws the band without a highlighted entry
    }
    return closed
  })

  // One line above the prompt: repo counts and this session's PRs, each one pressable.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const d = await read($, data)
    const mine = await read($, sessionPrs)
    if (!d.repo && !d.error && !mine.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    const current = await read($, solo)
    const shown = await read($, detail)
    // Opens the pane showing only that category; pressing the one already shown closes it.
    const openOn = async (t: Tab) => {
      if (isPaneOpen && (await read($, solo)) === t && !(await read($, detail))) {
        await $.ui.close({ id: PANE })
        return
      }
      await update($, run, () => null)
      await update($, detail, () => null)
      await update($, shownMilestone, () => null)
      await showInPane($, t, TABS.find(x => x.id === t)!.label)
    }
    // Opens a session PR straight in its detail view; pressing it again closes the pane.
    const openSessionPr = async (p: SessionPr) => {
      const open = await read($, detail)
      if (isPaneOpen && open?.kind === 'pr' && open.number === p.number && open.repo === p.repo) {
        await $.ui.close({ id: PANE })
        return
      }
      void openPr($, p.repo, p)
      await showInPane($, 'session', `PR #${p.number}`)
    }
    const isOn = (t: Tab) => isPaneOpen && current === t && !shown
    const isPrOn = (p: SessionPr) => isPaneOpen && shown?.kind === 'pr' && shown.number === p.number && shown.repo === p.repo

    const failing = d.prs.filter(p => p.checks === 'fail').length
    // Already in session order (open first); the band stays one line however many the session has.
    const onBand = mine.slice(0, BAND_PRS)
    const hidden = mine.length - onBand.length
    const milestone =
      [...d.milestones].filter(m => m.dueOn).sort((a, b) => Date.parse(a.dueOn!) - Date.parse(b.dueOn!))[0] ??
      [...d.milestones].sort((a, b) => b.open - a.open)[0]
    const pct = milestone && milestone.open + milestone.closed ? Math.round((milestone.closed / (milestone.open + milestone.closed)) * 100) : 0

    const prMark = (p: SessionPr) => {
      if (p.state === 'MERGED') return <Text color="magenta"> merged</Text>
      if (p.state === 'CLOSED') return <Text color="red"> closed</Text>
      if (p.checks === 'fail') return <Text color="red"> ✗</Text>
      if (p.checks === 'pending') return <Text color="yellow"> ⏳</Text>
      if (p.checks === 'pass') return <Text color="green"> ✓</Text>
      return p.isDraft ? <Text dimColor> draft</Text> : ''
    }

    return (
      <Box flexDirection="row" gap={1}>
        {d.error ? <Text color="red" wrap="truncate-end">GitHub ⚠ {d.error}</Text> : null}
        {!d.error && d.repo ? <Text dimColor wrap="truncate-end">GitHub · {d.repo}</Text> : null}
        {!d.error && d.repo ? (
          <Button key="band-issues" hotkey="i" onPress={() => openOn('issues')}>
            <Text bold={isOn('issues')} inverse={isOn('issues')}>Issues {d.issues.length}</Text>
          </Button>
        ) : null}
        {!d.error && d.repo ? (
          <Button key="band-prs" hotkey="p" onPress={() => openOn('prs')}>
            <Text bold={isOn('prs')} inverse={isOn('prs')}>PRs {d.prs.length}</Text>
            {failing ? <Text color="red"> {failing}✗</Text> : ''}
          </Button>
        ) : null}
        {!d.error && d.repo ? (
          <Button key="band-milestones" hotkey="m" onPress={() => openOn('milestones')}>
            <Text bold={isOn('milestones')} inverse={isOn('milestones')}>{milestone ? `${milestone.title} ${pct}%` : 'Milestones 0'}</Text>
          </Button>
        ) : null}
        {mine.length ? <Text dimColor>·</Text> : null}
        {onBand.map(p => (
          <Button key={`session-pr-${safeKey(p.repo)}-${p.number}`} onPress={() => openSessionPr(p)}>
            <Text bold={isPrOn(p)} inverse={isPrOn(p)} dimColor={!p.created && !isPrOn(p)}>#{p.number}</Text>
            {prMark(p)}
          </Button>
        ))}
        {hidden ? (
          <Button key="band-session-more" onPress={() => openOn('session')}>
            <Text bold={isOn('session')} inverse={isOn('session')} dimColor={!isOn('session')}>+{hidden}</Text>
          </Button>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const only = await read($, solo)
    const current = only ?? (await read($, tab))
    const d = await read($, data)
    const now = await $.clock.now()
    const shown = await read($, detail)
    const width = e.props.bodyColumns
    const icon = (r: CheckResult) =>
      r === 'pass' ? <Text color="green">✓</Text> : r === 'fail' ? <Text color="red">✗</Text> : r === 'pending' ? <Text color="yellow">⏳</Text> : <Text dimColor>–</Text>

    const wf = await read($, run)
    if (wf) {
      const isRunning = wf.status !== 'completed'
      const failedJobs = wf.jobs.filter(j => j.result === 'fail').length
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" gap={2}>
            <Button key="run-back" hotkey="b" onPress={() => update($, run, () => null)} label="← back" />
            <Button key="run-web" hotkey="o" onPress={() => openWeb($, ['run', 'view', String(wf.runId), '--repo', wf.repo], 'the run')} label="↗ Open on GitHub" />
            <Button key="run-refresh" hotkey="r" onPress={() => loadRun($)} label={wf.isRefreshing ? '↻ Refreshing…' : '↻ Refresh'} />
          </Box>
          <Text bold wrap="truncate-end">
            {icon(wf.result)} {wf.name}{wf.number ? <Text dimColor> · run #{wf.number}{wf.attempt > 1 ? ` · attempt ${wf.attempt}` : ''}</Text> : null}
          </Text>
          {wf.isLoading ? null : (
            <Text dimColor wrap="truncate-end">
              {wf.branch}{wf.event ? ` · ${wf.event}` : ''}
              {isRunning
                ? ` · ${wf.status === 'queued' ? 'queued' : 'running'}${wf.startedAt ? ` for ${duration(wf.startedAt, now)}` : ''} · refreshes every ${LIVE_MS / 1000}s`
                : wf.startedAt ? ` · ${duration(wf.startedAt, wf.updatedAt)}` : ''}
            </Text>
          )}
          <Text dimColor>{'─'.repeat(Math.min(60, width))}</Text>
          {wf.isLoading ? <Text dimColor>Loading…</Text>
            : wf.error ? <Text color="red">⚠ {wf.error}</Text>
            : wf.jobs.map(j => (
              <Box key={`job-${j.id}`} flexDirection="column">
                <Button key={`job-${j.id}`} plain onPress={() => openWeb($, ['run', 'view', '--job', String(j.id), '--repo', wf.repo], j.name)}>
                  {icon(j.result)}
                  <Text bold={j.result === 'fail'}> {j.name}</Text>
                  <Text dimColor>  {j.result === 'pending' ? (j.startedAt ? `running ${duration(j.startedAt, now)}` : 'queued') : duration(j.startedAt, j.completedAt)}</Text>
                </Button>
                {j.failedSteps.map(st => (
                  <Text key={`step-${j.id}-${st}`} color="red" wrap="truncate-end">   ✗ {st}</Text>
                ))}
                {j.result !== 'fail' ? null
                  : j.log ? j.log.map((l, i) => <Text key={`log-${j.id}-${i}`} dimColor wrap="truncate-end">   │ {l}</Text>)
                  : j.logError ? <Text dimColor>   log not available: {j.logError}</Text>
                  : failedJobs <= 3 ? <Text dimColor>   Loading log…</Text> : null}
              </Box>
            ))}
          {!wf.isLoading && !isRunning && failedJobs ? (
            wf.rerun === 'confirm' ? (
              <Box flexDirection="column">
                <Text color="yellow" wrap="wrap">Re-run the {failedJobs} failed job{failedJobs === 1 ? '' : 's'} of {wf.name} #{wf.number}? This starts CI again on GitHub.</Text>
                <Box flexDirection="row" gap={2}>
                  <Button key="rerun-yes" hotkey="y" onPress={() => rerunFailed($)} label="Yes, re-run" />
                  <Button key="rerun-no" hotkey="n" onPress={() => update($, run, r => (r ? { ...r, rerun: 'idle' as const } : r))} label="Cancel" />
                </Box>
              </Box>
            ) : wf.rerun === 'sending' ? (
              <Text dimColor>Requesting the re-run…</Text>
            ) : (
              <Button key="rerun" hotkey="f" onPress={() => update($, run, r => (r ? { ...r, rerun: 'confirm' as const } : r))} label={`⟲ Re-run failed job${failedJobs === 1 ? '' : 's'}`} />
            )
          ) : null}
        </Box>
      )
    }

    if (shown) {
      const reviewWord = (s: string) =>
        s === 'APPROVED' ? <Text color="green">approved</Text> : s === 'CHANGES_REQUESTED' ? <Text color="red">requested changes</Text> : <Text dimColor>{s.toLowerCase().replace('_', ' ')}</Text>
      const isPr = shown.kind === 'pr'
      const isOpenPr = isPr && !shown.isLoading && shown.state === 'OPEN'
      const canMerge = isOpenPr && !shown.isDraft && shown.mergeable !== 'CONFLICTING' && shown.mergeState !== 'DIRTY'
      const MERGE_STATE: Record<string, [string, string]> = {
        CLEAN: ['green', 'ready to merge'],
        HAS_HOOKS: ['green', 'ready to merge'],
        UNSTABLE: ['yellow', 'mergeable, with failing checks'],
        BLOCKED: ['yellow', 'blocked (reviews or checks missing)'],
        BEHIND: ['yellow', 'behind the base branch'],
        DIRTY: ['red', 'has conflicts'],
        DRAFT: ['gray', 'draft'],
      }
      const badge = !isPr ? null
        : shown.state === 'MERGED' ? (
          <Text wrap="truncate-end">
            <Text bold color="magenta">● Merged</Text>
            <Text dimColor>{shown.mergedBy ? ` by @${shown.mergedBy}` : ''}{shown.mergedAt ? ` ${ago(shown.mergedAt, now)} ago` : ''}</Text>
          </Text>
        ) : shown.state === 'CLOSED' ? (
          <Text wrap="truncate-end">
            <Text bold color="red">● Closed without merging</Text>
            <Text dimColor>{shown.closedAt ? ` ${ago(shown.closedAt, now)} ago` : ''}</Text>
          </Text>
        ) : shown.state ? (
          <Text wrap="truncate-end">
            {shown.isDraft ? <Text bold dimColor>● Draft</Text> : <Text bold color="green">● Open</Text>}
            {shown.mergeable === 'CONFLICTING'
              ? <Text color="red"> · has conflicts</Text>
              : MERGE_STATE[shown.mergeState] && !shown.isDraft
                ? <Text color={MERGE_STATE[shown.mergeState]![0] as any}> · {MERGE_STATE[shown.mergeState]![1]}</Text>
                : null}
          </Text>
        ) : null
      const state = shown.isDraft ? 'draft' : shown.state.toLowerCase()
      const { workflows, others } = groupWorkflows(shown.checks)
      const sortedOthers = [...others].sort((a, b) => ['fail', 'pending', 'pass', 'skip'].indexOf(a.result) - ['fail', 'pending', 'pass', 'skip'].indexOf(b.result))
      const jobsLabel = (w: WorkflowGroup) =>
        w.result === 'fail' ? `${w.failed} of ${w.total} job${w.total === 1 ? '' : 's'} failed`
          : w.result === 'pending' ? `${w.done}/${w.total} jobs done`
          : `${w.total} job${w.total === 1 ? '' : 's'}`
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" gap={2}>
            <Button key="back" hotkey="b" onPress={async () => { await update($, detail, () => null); await update($, solo, () => null) }} label="← back" />
            <Button key="open-web" hotkey="o" onPress={() => openOnGitHub($, shown)} label="↗ Open on GitHub" />
            <Button key="refresh-detail" hotkey="r" onPress={() => refreshDetail($)} label={shown.isRefreshing ? '↻ Refreshing…' : '↻ Refresh'} />
            {canMerge && shown.merge === 'idle' ? <Button key="merge" hotkey="m" onPress={() => askMerge($)} label="⇥ Merge" /> : null}
          </Box>
          <Text bold wrap="wrap">
            <Text color="green">#{shown.number}</Text> {shown.title}
          </Text>
          {badge}
          {isOpenPr && !canMerge ? (
            <Text dimColor wrap="truncate-end">
              {shown.isDraft ? "Can't merge a draft: mark it ready for review first." : 'Resolve the conflicts before merging.'}
            </Text>
          ) : null}
          {canMerge && shown.merge === 'confirm' ? (
            <Box flexDirection="column">
              <Text color="yellow" wrap="wrap">
                Merge #{shown.number} into {shown.base || 'the base branch'}? This changes {shown.base || 'it'} on GitHub.
                {shown.bypass ? ' Required reviews and checks will be bypassed.' : ''}
              </Text>
              {shown.canBypass ? (
                <Box flexDirection="row" gap={1}>
                  <Button key="merge-bypass" hotkey="a" onPress={() => update($, detail, x => (x ? { ...x, bypass: !x.bypass } : x))}
                    label={`${shown.bypass ? '☑' : '☐'} Merge as admin, bypassing the rules`} />
                  {shown.mergeState === 'BLOCKED' && !shown.bypass ? <Text dimColor>blocked: this lets you merge anyway</Text> : null}
                </Box>
              ) : null}
              {shown.mergeMethods.length ? (
                <Box flexDirection="row" gap={2}>
                  {MERGE_METHODS.filter(m => shown.mergeMethods.includes(m.id)).map(m => (
                    <Button key={`merge-${m.id}`} hotkey={m.hotkey} onPress={() => mergePr($, m.id)} label={m.label} />
                  ))}
                  <Button key="merge-cancel" hotkey="n" onPress={() => update($, detail, x => (x ? { ...x, merge: 'idle' as const } : x))} label="Cancel" />
                </Box>
              ) : <Text dimColor>Checking the repo's merge methods…</Text>}
            </Box>
          ) : null}
          {shown.merge === 'sending' ? <Text dimColor>Merging…</Text> : null}
          <Text dimColor wrap="truncate-end">
            {isPr ? '' : state}{shown.author ? `${isPr ? '' : ' · '}@${shown.author}` : ''}{shown.createdAt ? ` · ${ago(shown.createdAt, now)}` : ''}
            {shown.comments ? ` · ${shown.comments} comment${shown.comments === 1 ? '' : 's'}` : ''}
            {shown.assignees.length ? ` · assigned to @${shown.assignees.join(', @')}` : ''}
          </Text>
          {isPr && shown.branch ? (
            <Text dimColor wrap="truncate-end">
              {shown.branch} → {shown.base} · <Text color="green">+{shown.additions}</Text> <Text color="red">−{shown.deletions}</Text> · {shown.files} file{shown.files === 1 ? '' : 's'}
            </Text>
          ) : null}
          {shown.labels.length ? <Text color="magenta">{shown.labels.join(' · ')}</Text> : null}
          {isPr && (workflows.length || sortedOthers.length) ? (
            <Box flexDirection="column">
              <Text bold>CI{workflows.length ? <Text dimColor> · press a workflow for its jobs and logs</Text> : null}</Text>
              {workflows.map(w => (
                <Button key={`wf-${w.runId}`} plain onPress={() => openRun($, shown.repo, w.runId, w.name)}>
                  {icon(w.result)}
                  <Text> {w.name}</Text>
                  <Text dimColor>  {jobsLabel(w)}{w.startedAt ? ` · ${w.completedAt ? duration(w.startedAt, w.completedAt) : `running ${duration(w.startedAt, now)}`}` : ''}</Text>
                </Button>
              ))}
              {sortedOthers.slice(0, 6).map((c, i) => (
                <Text key={`check-${i}`} wrap="truncate-end">{icon(c.result)} {c.name}</Text>
              ))}
              {sortedOthers.length > 6 ? <Text dimColor>+{sortedOthers.length - 6} more</Text> : null}
            </Box>
          ) : null}
          {isPr && shown.reviews.length ? (
            <Text wrap="wrap">
              <Text bold>Reviews </Text>
              {shown.reviews.map((r, i) => (
                <Text key={`review-${i}`}>{i ? ' · ' : ''}@{r.author} {reviewWord(r.state)}</Text>
              ))}
            </Text>
          ) : null}
          <Text dimColor>{'─'.repeat(Math.min(60, width))}</Text>
          {shown.isLoading ? <Text dimColor>Loading…</Text>
            : shown.error ? <Text color="red">⚠ {shown.error}</Text>
            : <Markdown key={`body-${shown.kind}-${shown.number}`} text={shown.body.trim() || '_No description._'} />}
        </Box>
      )
    }

    const ms = await read($, shownMilestone)
    if (ms) {
      const total = ms.open + ms.closed
      const pct = total ? Math.round((ms.closed / total) * 100) : 0
      const filled = Math.round(pct / 10)
      const open = ms.issues.filter(i => i.isOpen)
      const closed = ms.issues.filter(i => !i.isOpen).sort((a, b) => Date.parse(b.closedAt ?? b.updatedAt) - Date.parse(a.closedAt ?? a.updatedAt))
      const CLOSED_SHOWN = 10
      const overdue = ms.dueOn && ms.open && Date.parse(ms.dueOn) < now
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" gap={2}>
            <Button key="milestone-back" hotkey="b" onPress={() => update($, shownMilestone, () => null)} label="← back" />
            <Button key="milestone-web" hotkey="o" onPress={() => openUrl($, ms.url)} label="↗ Open on GitHub" />
            <Button key="milestone-refresh" hotkey="r" onPress={() => loadMilestone($)} label={ms.isRefreshing ? '↻ Refreshing…' : '↻ Refresh'} />
          </Box>
          <Text bold wrap="wrap"><Text color="blue">◇</Text> {ms.title}</Text>
          <Text wrap="truncate-end">
            <Text color={pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : undefined}>{'▰'.repeat(filled)}{'▱'.repeat(10 - filled)} {pct}%</Text>
            <Text dimColor> · {ms.closed} of {total} closed · </Text>
            <Text color={overdue ? 'red' : undefined} dimColor={!overdue}>{overdue ? `overdue, ${dueLabel(ms.dueOn)}` : dueLabel(ms.dueOn)}</Text>
          </Text>
          {ms.description.trim() ? <Text dimColor wrap="wrap">{ms.description.trim()}</Text> : null}
          <Text dimColor>{'─'.repeat(Math.min(60, width))}</Text>
          {ms.isLoading ? <Text dimColor>Loading…</Text>
            : ms.error ? <Text color="red">⚠ {ms.error}</Text>
            : !ms.issues.length ? (
              <Box flexDirection="column" paddingX={1} paddingY={1}>
                <Text bold><Text color="blue">◇</Text> No issues in this milestone yet</Text>
                <Text dimColor wrap="wrap">Add issues to it on GitHub to track them here.</Text>
              </Box>
            ) : (
              <Box flexDirection="column">
                <Text bold>Open <Text dimColor>{open.length}</Text></Text>
                {open.length ? open.map(i => (
                  <Button key={`ms-issue-${i.number}`} plain onPress={() => openIssue($, ms.repo, i)}>
                    <Text color="green">#{i.number}</Text>
                    <Text> {i.title}</Text>
                    {i.labels.length ? <Text color="magenta"> [{i.labels.slice(0, 2).join(', ')}]</Text> : ''}
                    <Text dimColor>{i.assignees.length ? ` @${i.assignees[0]}` : ''} · {ago(i.updatedAt, now)}</Text>
                  </Button>
                )) : <Text dimColor>Everything here is closed.</Text>}
                {closed.length ? <Text bold>Closed <Text dimColor>{closed.length}</Text></Text> : null}
                {closed.slice(0, CLOSED_SHOWN).map(i => (
                  <Button key={`ms-issue-${i.number}`} plain onPress={() => openIssue($, ms.repo, i)}>
                    <Text color="magenta">✓</Text>
                    <Text dimColor> #{i.number} {i.title}{i.closedAt ? ` · ${ago(i.closedAt, now)}` : ''}</Text>
                  </Button>
                ))}
                {closed.length > CLOSED_SHOWN ? <Text dimColor>+{closed.length - CLOSED_SHOWN} more closed</Text> : null}
              </Box>
            )}
        </Box>
      )
    }

    const mine = await read($, sessionPrs)
    const counts: Record<Tab, number> = { issues: d.issues.length, prs: d.prs.length, milestones: d.milestones.length, session: mine.length }
    const tabRow = (
      <Box flexDirection="row" gap={2}>
        {TABS.map(t => (
          <Button key={`tab-${t.id}`} hotkey={t.hotkey} onPress={async () => { await update($, detail, () => null); await update($, shownMilestone, () => null); await update($, tab, () => t.id) }}>
            <Text bold={t.id === current} inverse={t.id === current} color={t.id === current ? 'blue' : undefined}>
              {` ${t.label} ${counts[t.id]} `}
            </Text>
          </Button>
        ))}
        <Button key="refresh" hotkey="r" label="↻" onPress={() => refresh($)} />
      </Box>
    )

    const status = d.error ? (
      <Text color="red" wrap="truncate-end">⚠ {d.error}</Text>
    ) : (
      <Text dimColor wrap="truncate-end">
        {d.repo ?? 'detecting repo…'}
        {d.isLoading ? ' · updating…' : d.fetchedAt ? ` · updated ${ago(new Date(d.fetchedAt).toISOString(), now) || '0m'} ago` : ''}
      </Text>
    )

    const repo = d.repo ?? ''
    let rows: RenderChildren[] = []
    if (current === 'issues') {
      rows = d.issues.map(i => (
        <Button key={`issue-${i.number}`} plain onPress={() => openIssue($, repo, i)}>
          <Text color="green">#{i.number}</Text>
          <Text> {i.title}</Text>
          {i.labels.length ? <Text color="magenta"> [{i.labels.slice(0, 2).join(', ')}]</Text> : ''}
          <Text dimColor>{i.assignees.length ? ` @${i.assignees[0]}` : ''} · {ago(i.updatedAt, now)}</Text>
        </Button>
      ))
    } else if (current === 'prs') {
      rows = d.prs.map(p => (
        <Button key={`pr-${p.number}`} plain onPress={() => openPr($, repo, p)}>
          <Text color="green">#{p.number}</Text>
          {p.checks === 'pass' ? <Text color="green"> ✓</Text> : p.checks === 'fail' ? <Text color="red"> ✗</Text> : p.checks === 'pending' ? <Text color="yellow"> ⏳</Text> : <Text dimColor> ·</Text>}
          {p.isDraft ? <Text dimColor> draft</Text> : ''}
          <Text> {p.title}</Text>
          {p.review === 'APPROVED' ? <Text color="green"> approved</Text> : p.review === 'CHANGES_REQUESTED' ? <Text color="red"> changes requested</Text> : ''}
          <Text dimColor> @{p.author} · {ago(p.updatedAt, now)}</Text>
        </Button>
      ))
    } else if (current === 'session') {
      rows = mine.map(p => (
        <Button key={`spr-${safeKey(p.repo)}-${p.number}`} plain onPress={() => openPr($, p.repo, p)}>
          <Text color={p.created ? 'green' : undefined} dimColor={!p.created}>#{p.number}</Text>
          {p.state === 'MERGED' ? <Text color="magenta"> merged</Text>
            : p.state === 'CLOSED' ? <Text color="red"> closed</Text>
            : p.checks === 'fail' ? <Text color="red"> ✗</Text>
            : p.checks === 'pending' ? <Text color="yellow"> ⏳</Text>
            : p.checks === 'pass' ? <Text color="green"> ✓</Text>
            : p.isDraft ? <Text dimColor> draft</Text> : ''}
          <Text dimColor> {p.repo}{p.created ? '' : ' · related'}</Text>
        </Button>
      ))
    } else {
      rows = d.milestones.map(m => {
        const total = m.open + m.closed
        const pct = total ? Math.round((m.closed / total) * 100) : 0
        const filled = Math.round(pct / 10)
        return (
          <Button key={`milestone-${m.number}`} plain onPress={() => openMilestone($, repo, m)}>
            <Text bold>{m.title}</Text><Text>{'  '}</Text>
            <Text color={pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : undefined}>
              {'▰'.repeat(filled)}{'▱'.repeat(10 - filled)} {pct}%
            </Text>
            <Text dimColor> {m.closed}/{total} · {dueLabel(m.dueOn)}</Text>
          </Button>
        )
      })
    }

    // Shown when the current tab has nothing: what it means, and what to do next.
    const EMPTY_COPY: Record<Tab, { icon: string; title: string; hint: string; action?: [string, string] }> = {
      issues: {
        icon: '◎', title: 'No open issues',
        hint: 'Nothing is waiting to be worked on in this repo.',
        action: ['New issue', `https://github.com/${repo}/issues/new`],
      },
      prs: {
        icon: '⇄', title: 'No open pull requests',
        hint: 'Every change has been merged or closed.',
        action: ['New pull request', `https://github.com/${repo}/compare`],
      },
      milestones: {
        icon: '◇', title: 'No open milestones',
        hint: 'Group issues and PRs into a milestone to track progress here.',
        action: ['New milestone', `https://github.com/${repo}/milestones/new`],
      },
      session: {
        icon: '◌', title: 'No PRs in this session yet',
        hint: 'PRs this session creates or mentions show up here automatically.',
      },
    }
    const copy = EMPTY_COPY[current]
    const isWaiting = current !== 'session' && (d.isLoading || !d.fetchedAt)
    const emptyState = isWaiting ? (
      <Box paddingX={1} paddingY={1}><Text dimColor>Loading…</Text></Box>
    ) : (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold>
          <Text color="blue">{copy.icon}</Text> {copy.title}
        </Text>
        <Text dimColor wrap="wrap">{copy.hint}</Text>
        {copy.action && repo ? (
          <Text>
            <Text dimColor>→ </Text>
            <Link href={copy.action[1]}>{copy.action[0]}</Link>
          </Text>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {only ? null : tabRow}
        {status}
        {rows.length ? rows : emptyState}
      </Box>
    )
  })
}

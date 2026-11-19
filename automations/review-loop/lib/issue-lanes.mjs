import { execFile } from "node:child_process"
import { basename } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function issueKey(url) {
  return url.replace(/\/$/, "").toLowerCase()
}

function repositoryKey(remote) {
  const value = remote.trim().replace(/\.git\/?$/, "").replace(/\/$/, "")
  const scp = value.match(/^[^@]+@([^:]+):(.+)$/)
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase()
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname}`.toLowerCase()
  } catch { return null }
}

/** Serialize kickoff for a repository/issue and reject any registered owner. */
export async function withIssueLane({ state, issue, run, exec = execFileAsync }) {
  const key = issueKey(issue.url)
  const claimKey = `issue:${key}`
  const token = state.claimLane(claimKey)
  if (!token) throw new Error(`A TARS lane kickoff for ${issue.url} is already in progress.`)
  const timer = setInterval(() => state.renewLaneClaim(claimKey, token), 10_000)
  timer.unref()
  try {
    let existing = state.lanesForIssue(key)[0]
    if (!existing) {
      const url = new URL(issue.url)
      const repo = `${url.host}${url.pathname.replace(/\/issues\/\d+$/, "")}`.toLowerCase()
      // Older lanes predate explicit issue bindings. Never infer ownership
      // from a bare issue number across different repositories.
      for (const lane of state.lanes()) {
        if (state.laneIssue(lane.worktreePath) || !new RegExp(`^issue-${issue.number}-`).test(basename(lane.worktreePath))) continue
        let remote
        try { remote = await exec("git", ["-C", lane.worktreePath, "remote", "get-url", "origin"]) }
        catch { continue }
        if (repositoryKey(remote.stdout) !== repo) continue
        state.bindLaneIssue(lane.worktreePath, key)
        existing = lane
        break
      }
    }
    if (existing) throw new Error(`A registered TARS lane already owns ${issue.url}: ${existing.worktreePath} (${existing.state}). Resume that lane or retire it before starting another.`)
    return await run()
  } finally {
    clearInterval(timer)
    state.releaseLane(claimKey, token)
  }
}

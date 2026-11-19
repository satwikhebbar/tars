import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Read an actual issue: gh issue view also accepts pull request numbers. */
export async function readIssue(repoPath, issueNumber, { exec = execFileAsync } = {}) {
  const { stdout } = await exec(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "number,title,body,labels,url,state"],
    { cwd: repoPath },
  )
  const result = JSON.parse(stdout)
  let url
  try { url = new URL(result.url) } catch { throw new Error(`Cannot verify GitHub issue #${issueNumber}: missing or invalid URL.`) }
  if (/\/pull\/\d+\/?$/.test(url.pathname)) {
    throw new Error(`#${issueNumber} is a pull request (${result.url}), not an issue. Use its linked issue number with --issue; no lane was created.`)
  }
  if (result.number !== issueNumber || !url.pathname.endsWith(`/issues/${issueNumber}`)) {
    throw new Error(`Cannot verify GitHub issue #${issueNumber}: lookup returned a different number or a non-issue URL.`)
  }
  if (result.state === "CLOSED") throw new Error(`GitHub issue #${issueNumber} is closed (${result.url}); no lane was created.`)
  if (result.state !== "OPEN") throw new Error(`Cannot verify GitHub issue #${issueNumber}: missing or invalid issue state.`)
  return { ...result, labels: result.labels.map((label) => label.name) }
}

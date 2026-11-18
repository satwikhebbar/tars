import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
export const PR_FEEDBACK_INTERVAL_MS = 15 * 60_000

const THREADS_QUERY = `
query($id: ID!, $endCursor: String) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 1) {
            nodes {
              body url fullDatabaseId
              pullRequestReview {
                id body url state submittedAt authorCanPushToRepository
                author { __typename login }
              }
            }
          }
        }
      }
    }
  }
}`

/** Read unresolved inline threads from submitted reviews by users with push access. */
export async function readPrFeedback(worktreePath, { exec = execFileAsync } = {}) {
  const gh = async (args) => {
    const { stdout } = await exec("gh", args, { cwd: worktreePath, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(stdout)
  }
  let pr
  try {
    pr = await gh(["pr", "view", "--json", "id,url,state,isDraft"])
  } catch (error) {
    if (/^no pull requests found for branch\b/im.test(error.stderr ?? "")) return null
    throw error
  }
  if (pr.state !== "OPEN" || pr.isDraft) return null

  const { hostname } = new URL(pr.url)
  const pages = await gh(["api", "graphql", "--hostname", hostname, "--paginate", "--slurp", "-f", `query=${THREADS_QUERY}`, "-f", `id=${pr.id}`])
  const reviews = new Map()
  for (const page of pages) {
    if (page.errors?.length || !page.data?.node?.reviewThreads) throw new Error(`Could not read review threads for ${pr.url}`)
    for (const thread of page.data.node.reviewThreads.nodes) {
      const comment = thread.comments.nodes[0]
      const review = comment?.pullRequestReview
      if (thread.isResolved || !review?.submittedAt || !["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(review.state)) continue
      if (!review.authorCanPushToRepository || review.author?.__typename !== "User") continue

      const key = `pr-feedback:${review.id}:${review.submittedAt}`
      if (!reviews.has(key)) {
        reviews.set(key, {
          key, url: review.url, author: review.author.login, state: review.state,
          submittedAt: review.submittedAt, body: review.body, threads: [],
        })
      }
      reviews.get(key).threads.push({
        id: thread.id, path: thread.path, line: thread.line, originalLine: thread.originalLine,
        isOutdated: thread.isOutdated, commentId: comment.fullDatabaseId, url: comment.url, body: comment.body,
      })
    }
  }
  return { url: pr.url, reviews: [...reviews.values()].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)) }
}

export async function snapshotPrFeedback(feedback) {
  const directory = await mkdtemp(join(tmpdir(), "tars-pr-feedback-"))
  const path = join(directory, "feedback.json")
  await writeFile(path, JSON.stringify(feedback, null, 2), { mode: 0o600 })
  return path
}

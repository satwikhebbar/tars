import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { parseFrontmatter, validateWorkflowHandoff } from "./handoff.mjs"

const exec = promisify(execFile)
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/** Resolve HEAD through Git; no model-provided revision enters this command. */
export async function headCommit(worktreePath) {
  const { stdout } = await exec("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"])
  return stdout.trim()
}

/** Validate immutable identity, including object type, without substituting HEAD. */
export async function validateHandoffCommit(handoff, worktreePath) {
  if (handoff?.metadata?.type !== "implementation-response") return []
  const sha = handoff.metadata.head_commit
  if (typeof sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    return ["head_commit must be a full Git commit SHA; use tars handoff publish"]
  }
  try {
    const { stdout } = await exec("git", ["-C", worktreePath, "cat-file", "-t", sha])
    if (stdout.trim() === "commit") return []
  } catch { /* Report a protocol error rather than sending an unusable target. */ }
  return [`head_commit ${sha} is not an available commit in this worktree; republish with tars handoff publish`]
}

/** Publish a complete implementation response in one filesystem operation. */
export async function publishHandoff({ draftPath, worktreePath = process.cwd() }) {
  worktreePath = resolve(worktreePath)
  const contents = await readFile(draftPath, "utf8")
  const match = contents.match(FRONTMATTER)
  if (!match) throw new Error("Draft requires YAML frontmatter")
  const metadata = parseFrontmatter(match[1])
  if (metadata.type !== "implementation-response") throw new Error("handoff publish requires an implementation-response draft")
  if (typeof metadata.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(metadata.id)) throw new Error("Draft id must be a safe filename component")
  const sha = await headCommit(worktreePath)
  // Remove every prior field, including duplicates; preserve all other draft text.
  const frontmatter = match[1].split(/\r?\n/).filter((line) => !/^head_commit\s*:/.test(line)).join("\n")
  const published = `---\n${frontmatter}\nhead_commit: ${sha}\n---\n${contents.slice(match[0].length)}`
  const handoff = { metadata: parseFrontmatter(`${frontmatter}\nhead_commit: ${sha}`) }
  const errors = validateWorkflowHandoff(handoff)
  if (errors.length) throw new Error(`Invalid handoff: ${errors.join(", ")}`)
  const output = join(worktreePath, ".agent-handoff", "inbox", `${metadata.id}.md`)
  await mkdir(dirname(output), { recursive: true })
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, published, { flag: "wx" })
    // link is atomic and refuses to overwrite an existing published handoff.
    await link(temporary, output)
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error })
  }
  return { path: output, headCommit: sha }
}

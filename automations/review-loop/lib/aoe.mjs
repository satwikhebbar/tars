import { execFile } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Adapter around AoE's documented CLI, isolated for testability. */
export class AoeClient {
  constructor(command = "aoe") {
    this.command = command
  }

  async listSessions() {
    const { stdout } = await execFileAsync(this.command, ["list", "--json"])
    return JSON.parse(stdout)
  }

  async runningSessions() {
    const { stdout } = await execFileAsync(this.command, ["ps", "--json"])
    return JSON.parse(stdout)
  }

  async runtimeSessions({ includeDead = false } = {}) {
    const args = ["ps", "--json"]
    if (includeDead) args.push("--dead")
    const { stdout } = await execFileAsync(this.command, args)
    return JSON.parse(stdout)
  }

  async send(sessionId, message) {
    await execFileAsync(this.command, ["send", sessionId, message])
  }

  async removeSession(sessionId, { deleteWorktree = false, deleteBranch = false } = {}) {
    const args = ["remove", sessionId]
    if (deleteWorktree) args.push("--delete-worktree")
    if (deleteBranch) args.push("--delete-branch")
    await execFileAsync(this.command, args)
  }

  async addSession(worktreePath, tool, title, { group } = {}) {
    const before = await this.listSessions()
    const args = ["add", worktreePath, "--tool", tool, "--title", title]
    if (group) args.push("--group", group)
    await execFileAsync(this.command, args)
    const session = await this.findNewSession(before, tool)
    await this.startSession(session.id)
    return session
  }

  async createWorktreeSession(repoPath, branch, title, { tool = "opencode", extraArgs = [], group } = {}) {
    const before = await this.listSessions()
    const args = [
      "add",
      repoPath,
      "--tool",
      tool,
      "--title",
      title,
      "--worktree",
      branch,
      "--new-branch",
    ]
    if (group) args.push("--group", group)
    // AoE forwards this value to the OpenCode process when the session starts.
    // Keep it a single argument because AoE owns shell splitting at that boundary.
    if (extraArgs.length) args.push("--extra-args", extraArgs.join(" "))
    await execFileAsync(this.command, args)
    const session = await this.findNewSession(before, tool)
    await this.startSession(session.id)
    return session
  }

  async moveSessionToGroup(sessionId, group) {
    await execFileAsync(this.command, ["group", "move", sessionId, group])
  }

  async startSession(sessionId) {
    await execFileAsync(this.command, ["session", "start", sessionId])
    await waitForSessionReady(this, sessionId)
  }

  async captureSession(sessionId) {
    const { stdout } = await execFileAsync(this.command, [
      "session",
      "capture",
      sessionId,
      "--lines",
      "20",
      "--strip-ansi",
      "--json",
    ])
    return JSON.parse(stdout)
  }

  async findNewSession(before, tool) {
    const priorIds = new Set(before.map((session) => session.id))
    const created = (await this.listSessions()).filter((session) => session.tool === tool && !priorIds.has(session.id))
    if (created.length !== 1)
      throw new Error(`Expected one newly-created ${tool} AoE session; found ${created.length}.`)
    return created[0]
  }
}

/**
 * Waits until AoE can read visible terminal content before sending an initial
 * prompt. `aoe session start` returns as soon as tmux exists, which can be
 * before an interactive agent has installed its input handler.
 */
export async function waitForSessionReady(client, sessionId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const sleep = options.sleep ?? delay
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const capture = await client.captureSession(sessionId)
      if (capture.content?.trim()) {
        // Let the terminal UI finish installing its key handler after first paint.
        await sleep(500)
        return
      }
    } catch (error) {
      lastError = error
    }
    await sleep(pollIntervalMs)
  }

  const detail = lastError instanceof Error ? ` (${lastError.message})` : ""
  throw new Error(`AoE session ${sessionId} did not become ready within ${timeoutMs}ms${detail}`)
}

/** Locates exactly one explicitly role-bound session pair in a worktree. */
export async function discoverPair(client, worktreePath, roles) {
  const legacyShape = !roles
  roles ??= { author: { tool: "opencode", displayName: "OpenCode" }, reviewer: { tool: "codex", displayName: "Codex" } }
  const sessions = await client.listSessions()
  const matching = sessions.filter((session) => session.path === worktreePath)
  if (roles.author.tool === roles.reviewer.tool) {
    throw new Error("Author and reviewer use the same harness; supply explicit --author-session and --reviewer-session.")
  }
  const author = matching.filter((session) => session.tool === roles.author.tool)
  const reviewer = matching.filter((session) => session.tool === roles.reviewer.tool)
  if (author.length !== 1 || reviewer.length !== 1) {
    throw new Error(
      `Expected exactly one ${roles.author.displayName} author and one ${roles.reviewer.displayName} reviewer AoE session for ${worktreePath}. Supply explicit --author-session and --reviewer-session when sessions are ambiguous.`,
    )
  }
  return legacyShape ? { opencodeSessionId: author[0].id, codexSessionId: reviewer[0].id } : { authorSessionId: author[0].id, reviewerSessionId: reviewer[0].id }
}

/** Verifies an explicitly supplied pair belongs to the selected worktree and roles. */
export async function validatePair(client, worktreePath, pair, roles) {
  roles ??= { author: { tool: "opencode", displayName: "OpenCode" }, reviewer: { tool: "codex", displayName: "Codex" } }
  pair = { authorSessionId: pair.authorSessionId ?? pair.opencodeSessionId, reviewerSessionId: pair.reviewerSessionId ?? pair.codexSessionId }
  const sessions = await client.listSessions()
  const author = sessions.find((session) => session.id === pair.authorSessionId)
  const reviewer = sessions.find((session) => session.id === pair.reviewerSessionId)
  if (pair.authorSessionId === pair.reviewerSessionId) throw new Error("Author and reviewer must be separate AoE sessions.")
  if (author?.path !== worktreePath || author.tool !== roles.author.tool) {
    throw new Error(`AoE session ${pair.authorSessionId} is not the requested author session for ${worktreePath}.`)
  }
  if (reviewer?.path !== worktreePath || reviewer.tool !== roles.reviewer.tool) {
    throw new Error(`AoE session ${pair.reviewerSessionId} is not the requested reviewer session (not a Codex session) for ${worktreePath}.`)
  }
  return pair
}

/** Creates an initially empty pair in one worktree, then returns its validated IDs. */
export async function createPair(client, worktreePath, roles) {
  const legacyShape = !roles
  roles ??= { author: { tool: "opencode", displayName: "OpenCode" }, reviewer: { tool: "codex", displayName: "Codex" } }
  const suffix = worktreePath.split("/").filter(Boolean).at(-1) ?? "worktree"
  const group = groupForWorktree(worktreePath)
  await client.addSession(worktreePath, roles.author.tool, `TARS author (${suffix})`, { group })
  await client.addSession(worktreePath, roles.reviewer.tool, `TARS reviewer (${suffix})`, { group })
  return discoverPair(client, worktreePath, legacyShape ? undefined : roles)
}

/** Provides a stable, visible AoE group for both sessions in one TARS lane. */
export function groupForWorktree(worktreePath) {
  const name = worktreePath.split("/").filter(Boolean).at(-1) || "worktree"
  return `TARS/${name}`
}

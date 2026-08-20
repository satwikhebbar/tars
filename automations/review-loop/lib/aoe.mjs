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

  async createWorktreeSession(repoPath, branch, title, { extraArgs = [] } = {}) {
    const before = await this.listSessions()
    const args = [
      "add",
      repoPath,
      "--tool",
      "opencode",
      "--title",
      title,
      "--worktree",
      branch,
      "--new-branch",
    ]
    // AoE forwards this value to the OpenCode process when the session starts.
    // Keep it a single argument because AoE owns shell splitting at that boundary.
    if (extraArgs.length) args.push("--extra-args", extraArgs.join(" "))
    await execFileAsync(this.command, args)
    const session = await this.findNewSession(before, "opencode")
    await this.startSession(session.id)
    return session
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

/** Locates exactly one OpenCode and Codex session associated with a worktree. */
export async function discoverPair(client, worktreePath) {
  const sessions = await client.listSessions()
  const matching = sessions.filter((session) => session.path === worktreePath)
  const opencode = matching.filter((session) => session.tool === "opencode")
  const codex = matching.filter((session) => session.tool === "codex")
  if (opencode.length !== 1 || codex.length !== 1) {
    throw new Error(
      `Expected exactly one OpenCode and one Codex AoE session for ${worktreePath}; found ${opencode.length} and ${codex.length}.`,
    )
  }
  return { opencodeSessionId: opencode[0].id, codexSessionId: codex[0].id }
}

/** Verifies an explicitly supplied pair belongs to the selected worktree and roles. */
export async function validatePair(client, worktreePath, pair) {
  const sessions = await client.listSessions()
  const opencode = sessions.find((session) => session.id === pair.opencodeSessionId)
  const codex = sessions.find((session) => session.id === pair.codexSessionId)
  if (opencode?.path !== worktreePath || opencode.tool !== "opencode") {
    throw new Error(`AoE session ${pair.opencodeSessionId} is not an OpenCode session for ${worktreePath}.`)
  }
  if (codex?.path !== worktreePath || codex.tool !== "codex") {
    throw new Error(`AoE session ${pair.codexSessionId} is not a Codex session for ${worktreePath}.`)
  }
  return pair
}

/** Creates an initially empty pair in one worktree, then returns its validated IDs. */
export async function createPair(client, worktreePath) {
  const suffix = worktreePath.split("/").filter(Boolean).at(-1) ?? "worktree"
  await client.addSession(worktreePath, "opencode", `Review loop OpenCode (${suffix})`, { group: worktreePath })
  await client.addSession(worktreePath, "codex", `Review loop Codex (${suffix})`, { group: worktreePath })
  return discoverPair(client, worktreePath)
}

import { execFile } from "node:child_process"
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

  async send(sessionId, message) {
    await execFileAsync(this.command, ["send", sessionId, message])
  }

  async addSession(worktreePath, tool, title) {
    const before = await this.listSessions()
    await execFileAsync(this.command, ["add", worktreePath, "--tool", tool, "--title", title])
    const session = await this.findNewSession(before, tool)
    await this.startSession(session.id)
    return session
  }

  async createWorktreeSession(repoPath, branch, title) {
    const before = await this.listSessions()
    await execFileAsync(this.command, [
      "add",
      repoPath,
      "--tool",
      "opencode",
      "--title",
      title,
      "--worktree",
      branch,
      "--new-branch",
    ])
    const session = await this.findNewSession(before, "opencode")
    await this.startSession(session.id)
    return session
  }

  async startSession(sessionId) {
    await execFileAsync(this.command, ["session", "start", sessionId])
  }

  async findNewSession(before, tool) {
    const priorIds = new Set(before.map((session) => session.id))
    const created = (await this.listSessions()).filter((session) => session.tool === tool && !priorIds.has(session.id))
    if (created.length !== 1)
      throw new Error(`Expected one newly-created ${tool} AoE session; found ${created.length}.`)
    return created[0]
  }
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
  await client.addSession(worktreePath, "opencode", `Review loop OpenCode (${suffix})`)
  await client.addSession(worktreePath, "codex", `Review loop Codex (${suffix})`)
  return discoverPair(client, worktreePath)
}

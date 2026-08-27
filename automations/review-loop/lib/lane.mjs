import { access, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { groupForWorktree } from "./aoe.mjs"

/** Starts watching an existing pair after placing both role-bound sessions in its lane group. */
export async function startExistingLane({ aoe, state, worktreePath, pair, roles, maxRounds }) {
  const group = groupForWorktree(worktreePath)
  await aoe.moveSessionToGroup(pair.authorSessionId, group)
  await aoe.moveSessionToGroup(pair.reviewerSessionId, group)
  state.saveLane({
    worktreePath,
    ...pair,
    authorHarness: roles.author.key,
    reviewerHarness: roles.reviewer.key,
    authorTool: roles.author.tool,
    reviewerTool: roles.reviewer.tool,
    state: "watching",
    maxRounds,
  })
}

/** Registers an existing pair without starting another coordinator poller. */
export async function registerLane({ aoe, state, worktreePath, maxRounds, roles, pair, createSessions = false }) {
  const selected = createSessions ? await aoe.createPair(worktreePath, roles) : pair ?? await aoe.discoverPair(worktreePath, roles)
  const group = groupForWorktree(worktreePath)
  const authorSessionId = selected.authorSessionId ?? selected.opencodeSessionId
  const reviewerSessionId = selected.reviewerSessionId ?? selected.codexSessionId
  await aoe.moveSessionToGroup(authorSessionId, group)
  await aoe.moveSessionToGroup(reviewerSessionId, group)
  const lane = {
    worktreePath,
    ...selected,
    authorSessionId,
    reviewerSessionId,
    authorHarness: roles.author.key,
    reviewerHarness: roles.reviewer.key,
    authorTool: roles.author.tool,
    reviewerTool: roles.reviewer.tool,
    state: "watching",
    maxRounds,
  }
  state.saveLane(lane)
  return lane
}

/**
 * Updates a lane's review budget without changing its sessions.  An explicit
 * resume explicitly clears a prior stop and restores the lane to the phase
 * that was active when it stopped. It is deliberately opt-in because blocked
 * may also represent a reviewer-reported blocker.
 */
export function setLaneMaxRounds({ state, worktreePath, maxRounds, resume = false }) {
  const lane = normalizeLane(state.lane(worktreePath))
  if (!lane) throw new Error(`No registered lane for ${worktreePath}.`)
  const stateAfterResume = lane.phase === "planning" ? "planning" : "implementing"
  const updated = { ...lane, maxRounds, state: resume && lane.state === "blocked" ? stateAfterResume : lane.state }
  state.saveLane(updated)
  return updated
}

/** Creates one AoE-managed implementation worktree and its reviewer session. */
export async function startLane({ aoe, state, repoPath, issue, branch, worktreeName, maxRounds, openingPrompt, planning, planModel, roles, provision }) {
  roles ??= { author: { key: "opencode", tool: "opencode" }, reviewer: { key: "codex", tool: "codex" } }
  const author = await aoe.findOrCreateWorktreeSession(repoPath, branch, worktreeName, {
    tool: roles.author.tool,
    extraArgs: [...(roles.author.launchArgs ?? []), ...(planning === "required" ? ["--agent", "tars-plan", ...(planModel ? ["--model", planModel] : [])] : [])],
  })
  const worktreePath = author.path
  const group = groupForWorktree(worktreePath)
  await provision?.(worktreePath)
  await aoe.moveSessionToGroup(author.id, group)
  const reviewer = await aoe.addSession(worktreePath, roles.reviewer.tool, `Issue ${issue.number} reviewer`, {
    extraArgs: roles.reviewer.launchArgs ?? [],
    group,
  })
  state.saveLane({
    worktreePath,
    authorSessionId: author.id,
    reviewerSessionId: reviewer.id,
    opencodeSessionId: author.id,
    codexSessionId: reviewer.id,
    authorHarness: roles.author.key,
    reviewerHarness: roles.reviewer.key,
    authorTool: roles.author.tool,
    reviewerTool: roles.reviewer.tool,
    state: "watching",
    maxRounds,
    planning,
    phase: planning === "required" ? "planning" : "building",
    planModel: planModel ?? null,
  })
  await aoe.send(author.id, openingPrompt)
  return { worktreePath, authorSessionId: author.id, reviewerSessionId: reviewer.id, opencodeSessionId: author.id, codexSessionId: reviewer.id }
}

/**
 * Retires an approved AoE lane. AoE owns its worktree lock, so the reviewer
 * session is removed first and the implementation session performs the final
 * worktree and branch deletion.
 */
export async function closeLane({ aoe, state, worktreePath, force = false }) {
  const lane = normalizeLane(state.lane(worktreePath))
  if (!lane) throw new Error(`No registered lane for ${worktreePath}.`)
  if (!isApprovedForRetirement(lane) && !force) {
    throw new Error(`Lane ${worktreePath} is ${lane.state}; only approved lanes can be closed.`)
  }

  const sessions = await aoe.listSessions()
  const expectedIds = new Set([lane.authorSessionId, lane.reviewerSessionId])
  const trashedIds = await aoe.listTrashedSessionIds?.() ?? new Set()
  if ([...expectedIds].every((sessionId) => trashedIds.has(sessionId))) {
    await aoe.deleteGroup(groupForWorktree(worktreePath))
    state.deleteLane(worktreePath)
    return lane
  }

  const sessionsInWorktree = sessions.filter((session) => session.path === worktreePath)
  const unexpected = sessionsInWorktree.filter((session) => !expectedIds.has(session.id))
  if (unexpected.length) {
    throw new Error(
      `Refusing to close ${worktreePath}: it has unrelated AoE session(s): ${unexpected.map((s) => s.id).join(", ")}.`,
    )
  }

  const author = sessions.find((session) => session.id === lane.authorSessionId)
  const reviewer = sessions.find((session) => session.id === lane.reviewerSessionId)
  if (author && (author.path !== worktreePath || author.tool !== lane.authorTool)) {
    throw new Error(`AoE session ${author.id} is no longer the registered author session for ${worktreePath}.`)
  }
  if (reviewer && (reviewer.path !== worktreePath || reviewer.tool !== lane.reviewerTool)) {
    throw new Error(`AoE session ${reviewer.id} is no longer the registered reviewer session for ${worktreePath}.`)
  }
  if (!author && !reviewer) {
    throw new Error(
      `Neither registered AoE session exists for ${worktreePath}; cannot safely release its worktree lock.`,
    )
  }

  if (force) {
    await assertStoppedDeadSessions(aoe, [lane.authorSessionId, lane.reviewerSessionId])
  }

  if (author && reviewer) await aoe.removeSession(reviewer.id)
  const finalSession = author ?? reviewer
  await aoe.removeSession(finalSession.id, { deleteWorktree: true, deleteBranch: true })
  await aoe.deleteGroup(groupForWorktree(worktreePath))
  state.deleteLane(worktreePath)
  return lane
}

/**
 * A validation error may temporarily mask an already-approved lane while the
 * watcher preserves its prior state for recovery.  That stale handoff must not
 * prevent an otherwise complete, merged lane from being retired.
 */
function isApprovedForRetirement(lane) {
  return lane.state === "approved" || (lane.state === "invalid_handoff" && lane.invalidResumeState === "approved")
}

/**
 * Restores one stopped or trashed role session without dispatching workflow work.
 * The operator must explicitly resume/re-deliver a task afterwards, so recovery
 * cannot duplicate a push, pull-request operation, or handoff.
 */
export async function recoverLane({ aoe, state, worktreePath, role }) {
  const lane = normalizeLane(state.lane(worktreePath))
  if (!lane) throw new Error(`No registered lane for ${worktreePath}.`)
  if (role !== "author" && role !== "reviewer") throw new Error("lane recover requires --role author or --role reviewer.")

  const sessionId = role === "author" ? lane.authorSessionId : lane.reviewerSessionId
  const expectedTool = role === "author" ? lane.authorTool : lane.reviewerTool
  let sessions = await aoe.listSessions()
  let session = sessions.find((entry) => entry.id === sessionId)
  if (!session) throw new Error(`Registered ${role} AoE session ${sessionId} no longer exists; TARS cannot reconstruct it.`)
  if (session.tool !== expectedTool) throw new Error(`AoE session ${sessionId} is not the registered ${role} harness for ${worktreePath}.`)

  const trashed = isTrashedSession(session)
  if (trashed) {
    const restoreGitPointer = await prepareTrashedWorktreeGitPointer(session.path, worktreePath)
    let restored = false
    try {
      await aoe.restoreSession(sessionId)
      restored = true
    } finally {
      await restoreGitPointer?.({ restored })
    }
    sessions = await aoe.listSessions()
    session = sessions.find((entry) => entry.id === sessionId)
    if (!session || session.path !== worktreePath || session.tool !== expectedTool) {
      throw new Error(`AoE restored ${sessionId}, but it is not the registered ${role} session at ${worktreePath}.`)
    }
  } else if (session.path !== worktreePath) {
    throw new Error(`AoE session ${sessionId} is no longer located at the registered worktree ${worktreePath}.`)
  }

  await aoe.moveSessionToGroup(sessionId, groupForWorktree(worktreePath))
  const runtime = (await aoe.runtimeSessions({ includeDead: true })).find((entry) => entry.session === sessionId)
  const started = runtime?.state !== "running"
  if (started) await aoe.startSession(sessionId)
  return { lane, sessionId, role, restored: trashed, started }
}

function isTrashedSession(session) {
  return session.path?.includes("/.aoe-trash/")
}

/**
 * AoE's trash directory adds one path segment. Linked-worktree `.git` files
 * use relative gitdirs, so temporarily add that segment only when the original
 * target is broken and the adjusted target is known to exist.
 */
export async function prepareTrashedWorktreeGitPointer(trashedWorktreePath, worktreePath) {
  const gitFile = join(trashedWorktreePath, ".git")
  let original
  try {
    original = await readFile(gitFile, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  const match = /^(gitdir:\s*)(.+?)(\r?\n?)$/.exec(original)
  if (!match || isAbsolute(match[2])) return null
  const currentTarget = resolve(dirname(gitFile), match[2])
  const adjustedTarget = resolve(dirname(gitFile), "..", match[2])
  if (await pathExists(currentTarget) || !(await pathExists(adjustedTarget))) return null

  await writeFile(gitFile, `${match[1]}../${match[2]}${match[3]}`)
  return async ({ restored }) => {
    await writeFile(join(restored ? worktreePath : trashedWorktreePath, ".git"), original)
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function normalizeLane(lane) {
  if (!lane) return lane
  return {
    ...lane,
    authorSessionId: lane.authorSessionId ?? lane.opencodeSessionId,
    reviewerSessionId: lane.reviewerSessionId ?? lane.codexSessionId,
    authorTool: lane.authorTool ?? "opencode",
    reviewerTool: lane.reviewerTool ?? "codex",
  }
}

/**
 * Resolves the lane created for a GitHub issue without guessing from the
 * filesystem. Only TARS's `issue-<number>-<slug>` worktree convention is
 * eligible, and more than one eligible registered lane is an error.
 */
export function worktreeForIssue(state, issueNumber) {
  const worktreeName = new RegExp(`^issue-${issueNumber}-[a-z0-9]+(?:-[a-z0-9]+)*$`)
  const matches = state.lanes().filter((lane) => worktreeName.test(lane.worktreePath.split("/").at(-1)))
  if (matches.length === 1) return matches[0].worktreePath
  if (matches.length === 0) {
    throw new Error(
      `No registered lane with a worktree named issue-${issueNumber}-<slug>. Use lane close --worktree <path> instead.`,
    )
  }
  throw new Error(
    `Found ${matches.length} registered lanes with a worktree named issue-${issueNumber}-<slug>. Use lane close --worktree <path> instead.`,
  )
}

/**
 * An aborted lane is allowed to delete a non-approved worktree only after the
 * user has stopped both agents. Requiring AoE's dead tmux records prevents a
 * cleanup command from terminating or discarding work under a live pane.
 */
async function assertStoppedDeadSessions(aoe, sessionIds) {
  const runtimeSessions = await aoe.runtimeSessions({ includeDead: true })
  const liveOrMissing = sessionIds.filter((sessionId) => {
    const runtime = runtimeSessions.find((entry) => entry.session === sessionId)
    return runtime?.substrate !== "tmux" || runtime.state !== "dead"
  })
  if (liveOrMissing.length) {
    throw new Error(
      `Refusing forced close: stop both registered AoE sessions first and confirm their panes are dead. Not dead: ${liveOrMissing.join(", ")}.`,
    )
  }
}

export function issueOpeningPrompt(issue) {
  return `You are the author for GitHub issue #${issue.number}: ${issue.title}\n${issue.url ? `\n${issue.url}\n` : ""}\nThis lane is direct-build: begin implementation now. Its next durable artifact is an implementation-response handoff; do not ask the user to choose a planning workflow or create a plan artifact. Use the issue-kickoff skill to initialize this already-created AoE worktree, then continue its workflow. Do not create, move, or rename a worktree or branch. When implementation is ready, follow handoff-review to commit, verify, and publish the first implementation-response with created_by: author.`
}

export function planOpeningPrompt(issue) {
  return `You are the author planning GitHub issue #${issue.number}: ${issue.title}\n${issue.url ? `\n${issue.url}\n` : ""}\nUse the issue-kickoff skill to initialize this already-created AoE worktree. Remain in Plan mode: inspect and design only; do not edit implementation files. Write the requested plan artifact under plans/, commit that plan artifact, then follow handoff-review to publish a plan-review handoff with created_by: author. Do not begin implementation until TARS reports that the reviewer approved the plan.`
}

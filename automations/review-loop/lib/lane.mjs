/** Registers an existing pair without starting another coordinator poller. */
export async function registerLane({ aoe, state, worktreePath, maxRounds, createSessions = false }) {
  const pair = createSessions ? await aoe.createPair(worktreePath) : await aoe.discoverPair(worktreePath)
  state.saveLane({ worktreePath, ...pair, state: "watching", maxRounds })
  return pair
}

/** Creates one AoE-managed implementation worktree and its reviewer session. */
export async function startLane({ aoe, state, repoPath, issue, branch, worktreeName, maxRounds, openingPrompt, planning, planModel }) {
  const opencode = await aoe.findOrCreateWorktreeSession(repoPath, branch, worktreeName, {
    extraArgs: planning === "required" ? ["--agent", "plan", ...(planModel ? ["--model", planModel] : [])] : [],
  })
  const codex = await aoe.addSession(opencode.path, "codex", `Issue ${issue.number} reviewer`)
  const worktreePath = opencode.path
  state.saveLane({
    worktreePath,
    opencodeSessionId: opencode.id,
    codexSessionId: codex.id,
    state: "watching",
    maxRounds,
    planning,
    phase: planning === "required" ? "planning" : "building",
    planModel: planModel ?? null,
  })
  await aoe.send(opencode.id, openingPrompt)
  return { worktreePath, opencodeSessionId: opencode.id, codexSessionId: codex.id }
}

/**
 * Retires an approved AoE lane. AoE owns its worktree lock, so the reviewer
 * session is removed first and the implementation session performs the final
 * worktree and branch deletion.
 */
export async function closeLane({ aoe, state, worktreePath, force = false }) {
  const lane = state.lane(worktreePath)
  if (!lane) throw new Error(`No registered lane for ${worktreePath}.`)
  if (lane.state !== "approved" && !force) {
    throw new Error(`Lane ${worktreePath} is ${lane.state}; only approved lanes can be closed.`)
  }

  const sessions = await aoe.listSessions()
  const sessionsInWorktree = sessions.filter((session) => session.path === worktreePath)
  const expectedIds = new Set([lane.opencodeSessionId, lane.codexSessionId])
  const unexpected = sessionsInWorktree.filter((session) => !expectedIds.has(session.id))
  if (unexpected.length) {
    throw new Error(
      `Refusing to close ${worktreePath}: it has unrelated AoE session(s): ${unexpected.map((s) => s.id).join(", ")}.`,
    )
  }

  const opencode = sessions.find((session) => session.id === lane.opencodeSessionId)
  const codex = sessions.find((session) => session.id === lane.codexSessionId)
  if (opencode && (opencode.path !== worktreePath || opencode.tool !== "opencode")) {
    throw new Error(`AoE session ${opencode.id} is no longer the registered OpenCode session for ${worktreePath}.`)
  }
  if (codex && (codex.path !== worktreePath || codex.tool !== "codex")) {
    throw new Error(`AoE session ${codex.id} is no longer the registered Codex session for ${worktreePath}.`)
  }
  if (!opencode && !codex) {
    throw new Error(
      `Neither registered AoE session exists for ${worktreePath}; cannot safely release its worktree lock.`,
    )
  }

  if (force) {
    await assertStoppedDeadSessions(aoe, [lane.opencodeSessionId, lane.codexSessionId])
  }

  if (opencode && codex) await aoe.removeSession(codex.id)
  const finalSession = opencode ?? codex
  await aoe.removeSession(finalSession.id, { deleteWorktree: true, deleteBranch: true })
  state.deleteLane(worktreePath)
  return lane
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
  return `You are the implementation agent for GitHub issue #${issue.number}: ${issue.title}\n${issue.url ? `\n${issue.url}\n` : ""}\nUse the issue-kickoff skill to initialize this already-created AoE worktree, then continue its workflow. Do not create, move, or rename a worktree or branch. When implementation is ready, follow handoff-review to commit, verify, and publish the first implementation-response.`
}

export function planOpeningPrompt(issue) {
  return `You are the planning agent for GitHub issue #${issue.number}: ${issue.title}\n${issue.url ? `\n${issue.url}\n` : ""}\nUse the issue-kickoff skill to initialize this already-created AoE worktree. Remain in Plan mode: inspect and design only; do not edit implementation files. Write the requested plan artifact under plans/, commit that plan artifact, then follow handoff-review to publish a plan-review handoff for Codex. Do not begin implementation until TARS reports that Codex approved the plan.`
}

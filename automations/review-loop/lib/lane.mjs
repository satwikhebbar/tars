/** Registers an existing pair without starting another coordinator poller. */
export async function registerLane({ aoe, state, worktreePath, maxRounds, createSessions = false }) {
  const pair = createSessions ? await aoe.createPair(worktreePath) : await aoe.discoverPair(worktreePath)
  state.saveLane({ worktreePath, ...pair, state: "watching", maxRounds })
  return pair
}

/** Creates one AoE-managed implementation worktree and its reviewer session. */
export async function startLane({ aoe, state, repoPath, issue, branch, worktreeName, maxRounds, openingPrompt }) {
  const opencode = await aoe.findOrCreateWorktreeSession(repoPath, branch, worktreeName)
  const codex = await aoe.addSession(opencode.path, "codex", `Issue ${issue.number} reviewer`)
  const worktreePath = opencode.path
  state.saveLane({
    worktreePath,
    opencodeSessionId: opencode.id,
    codexSessionId: codex.id,
    state: "watching",
    maxRounds,
  })
  await aoe.send(opencode.id, openingPrompt)
  return { worktreePath, opencodeSessionId: opencode.id, codexSessionId: codex.id }
}

export function issueOpeningPrompt(issue) {
  return `You are the implementation agent for GitHub issue #${issue.number}: ${issue.title}\n${issue.url ? `\n${issue.url}\n` : ""}\nUse the issue-kickoff skill to initialize this already-created AoE worktree, then continue its workflow. Do not create, move, or rename a worktree or branch. When implementation is ready, follow handoff-review to commit, verify, and publish the first implementation-response.`
}

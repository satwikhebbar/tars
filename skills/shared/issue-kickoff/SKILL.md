---
name: issue-kickoff
description: Start work in an already-assigned TARS issue worktree. Use when a lane author receives an issue opening prompt.
---

# Issue Kickoff

1. Confirm the current directory, branch, and git remote are the assigned worktree.
2. Read the issue and repository instructions; TARS/AoE owns worktree and branch creation.
3. Inspect the project’s documented setup and validation commands. Install dependencies or local configuration only when the repository requires them.
4. Treat the opening prompt's workflow mode as authoritative:
   - For a direct-build lane, begin implementation immediately. Its next durable artifact is an implementation-response handoff.
   - For a planning lane, inspect and design only, then publish the requested plan-review handoff.
5. Use `handoff-review` when the lane is ready for the next role.

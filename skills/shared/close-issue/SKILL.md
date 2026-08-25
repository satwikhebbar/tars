---
name: close-issue
description: Close a completed issue after its TARS lane pull request has merged.
---

# Close Issue

Confirm the pull request is merged and close the issue through the repository's normal GitHub workflow. Then report that the approved lane is ready for retirement.

Lane retirement must be performed by a controller or operator outside the lane. Do not run `lane close` from the author or reviewer session: it removes those sessions together with the managed worktree and local branch. The external controller retires it with `node automations/review-loop/cli.mjs lane close --issue <number>` (or the explicit worktree path).

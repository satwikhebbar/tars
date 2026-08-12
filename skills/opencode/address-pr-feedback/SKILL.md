---
name: address-pr-feedback
description: Address reviewer feedback on an existing pull request in a TARS-approved lane. Use when the user asks to act on GitHub, CodeRabbit, or other PR comments after Codex has already approved the lane, then restart the Codex handoff review before updating that same PR.
---

# Address Pull Request Feedback

Continue work only in the current TARS lane worktree. The lane already has an
open pull request; do not create, move, or rename a worktree, branch, or PR.

1. Discover the PR for the current branch with `gh pr view` and read its open
   review comments. Include feedback the user supplies directly. If there is no
   open PR or the feedback is ambiguous, stop and ask for direction.
2. Apply the accepted feedback, run relevant verification, and commit the
   changes. Do not push yet: Codex must review this committed follow-up first.
3. Publish exactly one `.agent-handoff/inbox/` `implementation-response` using
   the `handoff-review` skill's normal shape, with a new `id`, the lane's stable
   `workflow_id`, `round: 1`, the current plan iteration when applicable,
   `head_commit`, and:

   ```yaml
   reopen: true
   ```

   In its body, identify the existing PR URL, summarize the feedback addressed,
   and record verification. This explicit marker is what permits TARS to reopen
   an approved lane and wake Codex.
4. Do not manually wake Codex, push the branch, or create a PR. The running
   TARS watcher dispatches the handoff. If Codex approves, TARS directs this
   same session to push the commit to the existing PR; if it requests changes,
   consume that handoff and continue the normal review loop.

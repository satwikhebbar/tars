---
name: close-issue
description: Close a GitHub issue after implementation. Use when the user says "close this issue", "mark this done", or asks you to comment on and close an issue.
---

# Close Issue

## Workflow

1. Verify commits address the issue — `git log --oneline -10`, `git show --stat <sha>`.

2. Find the related PR — `rtk gh pr list --repo <owner/repo> --state open --head <branch>` or check `gh pr view` for the issue's linked PR.

3. Before merging, check for uncommitted plan files: `rtk git status --short plans/`. If any exist, commit them — plans are source artifacts tracked in the repo.

4. Merge the PR — `rtk gh pr merge <N> --repo <owner/repo> --squash --delete-branch`. Use `--squash` unless the repo convention says otherwise.

5. If a plan file (e.g. `plans/`) is referenced, read it. Reference it in the closing comment by relative path.

6. Draft a closing comment. One outcome not obvious from commits/diff — scope decision, constraint, alternative chosen, plan divergence. No headings, no meta-labels ("outcome", "key detail"). No commit SHAs (issue links to them via references). If a plan exists, reference it naturally: `The plan at plans/foo.md covered X but deferred Y because Z.`

7. Present the draft to the user for review before posting.

8. Post the draft from step 6 as a comment. If the PR body contained `Closes #<N>` (auto-closes on merge): `rtk gh issue comment <N> --repo <owner/repo> --body "..."`. Otherwise: `rtk gh issue close <N> --repo <owner/repo> --comment "..."`. A comment is always posted regardless of auto-close status.

9. Clean up the worktree (created by issue-kickoff): first check for uncommitted tracked changes — `rtk git -C <worktree-path> status --porcelain`. If any tracked files are modified/staged, abort and alert the user. Otherwise `rtk git worktree remove --force <worktree-path>` (safe — only gitignored files like `.agent-handoff/` remain dirty). Then `rtk git branch -D <branch>` (remote was deleted via `--delete-branch` but local ref remains). Run from the main repo (not the worktree).

## Rules

- Draft adds info not in commit messages. Zero boilerplate, zero headings, zero framing.
- If no plan exists, skip step 5 and don't fabricate a reference.

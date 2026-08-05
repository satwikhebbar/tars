---
name: issue-kickoff
description: Initialize and begin work on a GitHub issue in an already-assigned worktree. Use when TARS or a user starts a new issue lane and asks OpenCode to pick it up, plan it, or implement it.
---

# Issue Kickoff

Initialize the assigned AoE worktree for a new issue and classify its type. TARS/AoE owns branch and worktree creation.

## Workflow

1. **Read the issue** — `rtk gh issue view <N> --repo <owner/repo>`.

2. **Verify assignment** — `pwd && git remote -v && git branch --show-current`. Confirm this is the assigned checkout and branch.

3. **Do not create or move worktrees** — retain the branch and worktree assigned by AoE/TARS. Report a mismatch rather than running `git worktree add` or changing branches.

4. **Fetch** — `git fetch origin` to get latest remote state when needed.

5. **Install deps** — `pnpm install` in the assigned worktree.

6. **Hooks** — `npx lefthook install`.

7. **Classify** — bug (broken behavior), enhancement (improves existing), feature (new capability). Share summary with user.

8. **Print summary**:
    ```
    Branch:   <branch>
    Worktree: <path>
    ```

9. **Next step**:
    - Bug → implement the fix directly.
    - Enhancement/Feature → ask "Should I draft a plan?" If yes, create plan in `plans/` as HTML, then implement.

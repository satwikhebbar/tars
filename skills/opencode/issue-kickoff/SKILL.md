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

7. **Local dev files** — `wrangler.local.toml` and `.dev.vars` are gitignored, so
   worktrees don't receive them and `pnpm dev` would fail. Copy them from the
   primary checkout (first entry of `git worktree list`). Skip `wrangler.prod.toml`;
   it is not needed for local dev. Both files stay untracked, so `git status` stays clean.

   ```bash
   PRIMARY=$(git worktree list | awk 'NR==1 {print $1}')
   cp -f "$PRIMARY/wrangler.local.toml" .
   cp -f "$PRIMARY/.dev.vars" .
   git status
   ```

8. **Classify** — bug (broken behavior), enhancement (improves existing), feature (new capability). Share summary with user.

9. **Print summary**:
    ```
    Branch:   <branch>
    Worktree: <path>
    ```

10. **Next step**:
    - Bug → implement the fix directly.
    - Enhancement/Feature → ask "Should I draft a plan?" If yes, create plan in `plans/` as HTML, then implement.

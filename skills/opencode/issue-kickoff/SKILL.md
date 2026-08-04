---
name: issue-kickoff
description: Pick up a new GitHub issue and set up a local worktree. Use when the user says "start new issue", "pick this up", "let's work on issue X", or "new issue" with a GitHub issue URL.
---

# Issue Kickoff

Set up a local worktree for a new issue and classify its type.

## Workflow

1. **Read the issue** — `rtk gh issue view <N> --repo <owner/repo>`.

2. **Verify repo** — `pwd && git remote -v`. Confirm you're in the right checkout.

3. **Branch name** — `<type>/<kebab-description>` where type is `fix` (bug), `feat` (new feature), or `enhance` (improvement to existing behavior).

4. **Fetch** — `git fetch origin` to get latest remote state.

5. **Worktree** — `git worktree add -b <branch> <path> origin/main` where path is `../<repo-name>--<branch>`.

6. **Install deps** — `pnpm install` in the new worktree.

7. **Hooks** — `npx lefthook install`.

8. **agmsg team** — replace `/` with `-` in branch name to get `<sanitized-name>`, then:
   ```
   bash ~/.agents/skills/agmsg/scripts/join.sh <sanitized-name> oc opencode "$(pwd)"
   ```

9. **Classify** — bug (broken behavior), enhancement (improves existing), feature (new capability). Share summary with user.

10. **Print summary**:
    ```
    Branch:   <branch>
    Worktree: <path>
    agmsg:    <sanitized-name>
    ```

11. **Next step**:
    - Bug → implement the fix directly.
    - Enhancement/Feature → ask "Should I draft a plan?" If yes, create plan in `plans/` as HTML, then implement.

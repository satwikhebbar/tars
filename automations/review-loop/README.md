# Agent review loop

`agent-review-loop` is a local coordinator for one OpenCode implementation session and one Codex review session per git worktree. AoE sends turns, and `.agent-handoff/` files are the durable workflow protocol.

## Start a lane

Start both AoE sessions in the same worktree, then run:

```bash
node automations/review-loop/cli.mjs start --worktree /absolute/path/to/worktree
```

The command discovers exactly one `opencode` and one `codex` AoE session whose path matches the canonical worktree path, persists the pair under `~/.local/state/agent-review-loop/state.sqlite`, and polls the active handoff directories every two seconds. Add `--create-sessions` when the pair does not yet exist; it creates and launches blank AoE sessions in that worktree. Pass both IDs to override discovery:

```bash
node automations/review-loop/cli.mjs start \
  --worktree /absolute/path/to/worktree \
  --opencode <aoe-session-id> --codex <aoe-session-id>
```

Use `--once` for a single scan and `--max-rounds 5` to cap a lane. View registered lanes with `node automations/review-loop/cli.mjs status`.

## Create and manage lanes

When a lane creates a new AoE session, TARS waits for the agent's terminal UI
to be ready before sending its first prompt. This avoids losing that prompt
during session startup.

For a new GitHub issue, let TARS ask OpenCode for a branch-name suggestion in a bounded, read-only preflight. TARS validates a single machine-readable directive, falls back to a deterministic name if necessary, and then lets AoE create the worktree and launch the one persistent OpenCode implementation session:

```bash
node automations/review-loop/cli.mjs lane start \
  --repo /absolute/path/to/main-checkout \
  --issue 44
```

The namer proposes both the branch and the AoE worktree name. Pass `--branch <name>` and, when needed, `--worktree-name <name>` to override them. The command prints the created worktree and both session IDs, then sends the implementation session its opening issue prompt. It does not start another polling loop.

Run one watcher to serve every registered lane:

```bash
node automations/review-loop/cli.mjs watch
```

Register an existing worktree/session pair without creating a competing watcher:

```bash
node automations/review-loop/cli.mjs lane register --worktree /absolute/path/to/worktree
```

After the approved branch has been merged and its issue closed, retire the lane
through TARS rather than Git directly:

```bash
node automations/review-loop/cli.mjs lane close --worktree /absolute/path/to/worktree
```

This removes the Codex AoE session first, then has AoE remove the OpenCode
session together with its managed worktree and local branch. It only accepts an
`approved` registered lane, refuses a worktree shared with unrelated AoE
sessions, and retains the lane record if AoE cannot complete cleanup.

## Protocol additions

Only handoffs carrying all of `id`, `workflow_id`, and integer `round` are actionable. This leaves existing handoff history safe to retain.

OpenCode writes an `implementation-response` after committing:

```yaml
id: calendar-fix-r2-response
type: implementation-response
workflow_id: calendar-fix
round: 2
head_commit: 0123abc
```

Codex writes a `code-review` handoff:

```yaml
id: calendar-fix-r2-review
type: code-review
workflow_id: calendar-fix
round: 2
outcome: changes_requested # approved | changes_requested | blocked
```

An implementation response wakes only that lane's Codex session. `changes_requested` wakes only its OpenCode session. On `approved`, the coordinator wakes OpenCode once to record the completed handoff, push the approved branch, and create a pull request; it then marks the lane approved. `blocked` or a round above the cap stops the lane. Events are journaled in SQLite after successful delivery, making scans idempotent across restarts.

# Agent review loop

`agent-review-loop` is a local coordinator for one OpenCode implementation session and one Codex review session per git worktree. It uses AoE only to send turns. The `.agent-handoff/` files are the durable workflow protocol; agmsg is optional and is not read by this tool.

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

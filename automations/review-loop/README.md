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
  --issue 44 \
  --planning auto
```

The bounded preflight proposes the branch, AoE worktree name, and whether the issue needs a plan. `--planning auto` (the default) accepts that decision; use `always` or `never` to override it. An invalid preflight falls back to the safer plan-first path. Pass `--plan-model <provider/model>` to launch a plan-first OpenCode session with a specific model.

For `planning: required`, TARS launches OpenCode with its `plan` agent, waits for Codex to approve the `plan-review`, sends `/compact`, then invokes the global `/tars-build` command to continue in OpenCode's `build` agent. Install that command once before starting a plan-first lane:

```bash
node commands/install.mjs opencode tars-build --force
```

For `planning: not_required`, TARS follows the original direct Build → code-review loop. The command prints the created worktree and both session IDs, then sends the appropriate opening issue prompt. It does not start another polling loop.

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

For lanes created with `lane start`, you can use the issue number instead:

```bash
node automations/review-loop/cli.mjs lane close --issue 44
```

TARS resolves only one registered worktree matching its `issue-44-<slug>`
naming convention. If none or more than one match, it fails and requires the
explicit `--worktree` path instead.

This removes the Codex AoE session first, then has AoE remove the OpenCode
session together with its managed worktree and local branch. It only accepts an
`approved` registered lane, refuses a worktree shared with unrelated AoE
sessions, and retains the lane record if AoE cannot complete cleanup.

To abort a lane before approval, first stop both its OpenCode and Codex AoE
sessions. Once AoE reports both tmux panes as dead, use the explicit override:

```bash
node automations/review-loop/cli.mjs lane close --issue 44 --force
```

`--force` does not terminate agents. It only permits a non-approved cleanup
after verifying that both registered session panes are already dead (and makes
the same verification for an approved lane when supplied).

## Protocol additions

Only handoffs carrying all of `id`, `workflow_id`, and integer `round` are actionable. This leaves existing handoff history safe to retain.

Before implementation, OpenCode can request a plan review from the lane worktree:

```yaml
id: 53-plan-review-1
type: plan-review
created_by: opencode
workflow_id: 53
round: 1
target:
  - plans/the-plan.html
```

Codex replies in that same worktree with `type: plan-review-verdict`, the same
`workflow_id` and `round`, `responds_to` set to the request id, and an
`approved`, `changes_requested`, or `blocked` outcome. Plan approval wakes
OpenCode through a lane-local compact → Build transition; it is not a terminal
lane approval and never creates a pull request. Plan changes requested wake
OpenCode to revise and republish the plan at the next round. Each transition is
persisted per lane, so concurrent lanes progress independently.

An approved plan verdict also contains an ordered `Implementation Iterations`
schedule and an `iteration_count` frontmatter value. TARS starts only iteration
1. Each iteration must commit, publish an `implementation-response` with its
`iteration`, and receive Codex approval before TARS starts the next one. A
requested change stays in the current iteration. Only approval of the final
iteration invokes the normal push-and-create-PR handoff. Direct Build lanes
remain a single iteration without extra plan-review steps.

OpenCode writes an `implementation-response` after committing:

```yaml
id: calendar-fix-r2-response
type: implementation-response
workflow_id: calendar-fix
round: 2
iteration: 1
head_commit: 0123abc
```

Codex writes a `code-review` handoff:

```yaml
id: calendar-fix-r2-review
type: code-review
workflow_id: calendar-fix
round: 2
iteration: 1
outcome: changes_requested # approved | changes_requested | blocked
```

An implementation response wakes only that lane's Codex session. `changes_requested` wakes only its OpenCode session. On `approved`, the coordinator wakes OpenCode once to record the completed handoff, push the approved branch, and create a pull request; it then marks the lane approved. `blocked` or a round above the cap stops the lane. Events are journaled in SQLite after successful delivery, making scans idempotent across restarts.

# Agent review loop

`agent-review-loop` is a local coordinator for one author and one reviewer session per git worktree. AoE sends turns, and `.agent-handoff/` files are the durable workflow protocol. Roles are independent: any supported harness can be either the author or reviewer, including two separate sessions of the same harness.

## Supported harnesses

TARS currently supports these AoE-backed harnesses:

- OpenCode
- Codex
- Claude Code
- Cursor

Setup lists only the harnesses currently installed through AoE. You choose default author and reviewer harnesses during setup, then can override either role when launching a lane.

## Start a lane

Start both AoE sessions in the same worktree, then run `start` with their roles. This OpenCode-author/Codex-reviewer pairing is one example:

```bash
tars start --worktree /absolute/path/to/worktree \
  --author opencode --reviewer codex
```

Run `node setup.mjs` once to select installed default roles and provision every supported harness discovered through AoE. Run `node setup.mjs provision` after installing another supported harness later. Per-lane flags override those defaults. The command discovers one session of each selected harness whose path matches the canonical worktree path, persists their role bindings under `~/.local/state/agent-review-loop/state.sqlite`, and polls the active handoff directories every two seconds. Add `--create-sessions` when the pair does not yet exist. When both roles use the same harness, or discovery is ambiguous, pass both IDs explicitly:

```bash
tars start \
  --worktree /absolute/path/to/worktree \
  --author claude --reviewer claude \
  --author-session <aoe-session-id> --reviewer-session <aoe-session-id>
```

Use `--once` for a single scan and `--max-rounds 5` to cap a lane. View registered lanes with `tars status`.

## Create and manage lanes

When a lane creates a new AoE session, TARS waits for the agent's terminal UI
to be ready before sending its first prompt. This avoids losing that prompt
during session startup.

For a new GitHub issue, TARS asks the selected author for a branch-name suggestion in a bounded, read-only preflight. TARS validates a single machine-readable directive, falls back to a deterministic plan-first name if necessary, and then lets AoE create the worktree and launch the role-bound sessions:

```bash
tars lane start \
  --repo /absolute/path/to/main-checkout \
  --issue 44 \
  --author claude --reviewer codex --planning auto
```

The bounded preflight proposes the branch, AoE worktree name, and whether the issue needs a plan. `--planning auto` (the default) accepts that decision; use `always` or `never` to override it. An invalid or unsupported preflight falls back to the safer plan-first path. `--plan-model <provider/model>` is available only when OpenCode is the author.

For `planning: required`, TARS launches its setup-installed OpenCode `tars-plan` agent rather than OpenCode's read-only built-in `plan` agent. It can write only the durable `plans/` and `.agent-handoff/` artifacts, waits for Codex to approve the `plan-review`, sends `/compact`, then invokes the global `/tars-build` command to transition the primary session to OpenCode's `build` agent. `setup.mjs` installs the planning agent; install the build command once before starting a plan-first lane:

```bash
node commands/install.mjs opencode tars-build --force
```

For `planning: not_required`, TARS follows the original direct Build → code-review loop. The command prints the created worktree and both session IDs, then sends the appropriate opening issue prompt. It does not start another polling loop.

### Claude Code productivity note

TARS currently launches Claude Code with its normal `claude` command, so its
user-level permission mode applies to every new Claude lane. To reduce routine
permission prompts on a trusted local machine, set this in
`~/.claude/settings.json`:

```json
{
  "permissions": { "defaultMode": "auto" }
}
```

`auto` uses Claude Code's safety checks rather than unconditionally approving
all actions. TARS does not yet expose this as a lane-level option; see the
backlog for harness-controlled launch settings.

Run one watcher to serve every registered lane:

```bash
tars watch
```

Register an existing worktree/session pair without creating a competing watcher:

```bash
tars lane register --worktree /absolute/path/to/worktree
```

After the approved branch has been merged and its issue closed, retire the lane
through TARS rather than Git directly:

```bash
tars lane close --worktree /absolute/path/to/worktree
```

For lanes created with `lane start`, you can use the issue number instead:

```bash
tars lane close --issue 44
```

TARS resolves only one registered worktree matching its `issue-44-<slug>`
naming convention. If none or more than one match, it fails and requires the
explicit `--worktree` path instead.

This removes the reviewer AoE session first, then has AoE remove the author
session together with its managed worktree and local branch. It only accepts an
`approved` registered lane, refuses a worktree shared with unrelated AoE
sessions, and retains the lane record if AoE cannot complete cleanup.

To abort a lane before approval, first stop both author and reviewer AoE
sessions. Once AoE reports both tmux panes as dead, use the explicit override:

```bash
tars lane close --issue 44 --force
```

`--force` does not terminate agents. It only permits a non-approved cleanup
after verifying that both registered session panes are already dead (and makes
the same verification for an approved lane when supplied).

### Recover an accidentally stopped lane session

If an AoE shortcut has stopped a role session or placed its worktree in AoE
trash, restore that role using the registered absolute worktree path:

```bash
tars lane recover \
  --worktree /absolute/path/to/worktree \
  --role author
```

Recovery restores only the named role, validates its registered harness and
worktree, restores its lane group, and starts it if it is not running. It also
repairs AoE's temporary relative `.git`-pointer issue when needed during a
trash restore. It does not replay a coordinator prompt or advance the lane;
explicitly tell the recovered harness what to do next after inspecting the
reported lane state. `--worktree` is required because issue numbers can collide
across repositories.

## Safe lane resume and recovery

An interrupted watcher, a restarted machine, or a session that dies after a
prompt is recorded can leave a lane with recorded-but-unprocessed deliveries or
stale state. `lane resume` diagnoses a lane from durable evidence — handoff
files, the persisted lane row, the dispatch journal, and AoE session liveness —
and takes a recovery action only when the operator asks for it explicitly:

```bash
tars lane resume --worktree /absolute/path/to/worktree
```

Without action flags this is read-only: it prints a verdict and the single next
pending action (or why none can be taken). It never sends prompts and never
mutates state. Action flags each enable exactly one recovery action and are
refused for any other verdict:

```bash
# Dispatch the single pending next action to its idle session.
tars lane resume --worktree <path> --dispatch

# Re-create a registered OpenCode/Codex session that no longer exists, then re-analyze.
tars lane resume --worktree <path> --create-sessions
```

Verdicts:

| Verdict | Meaning | Recovery |
|---|---|---|
| `needs_dispatch` | One actionable pending handoff; target session is idle/waiting. | `--dispatch` |
| `stale_delivery` | A recorded delivery has no advancement, its session is idle, and it is older than 10 minutes — the prompt likely never took effect. | `--dispatch` (re-journals and re-dispatches once) |
| `in_flight` | Already progressing: target session is busy, or a recent delivery/compact transition is waiting. | none |
| `no_action` | Nothing pending — delivery complete, or the lane is awaiting the agent's next handoff. | none |
| `sessions_missing` | A registered session is absent from AoE, or its id no longer matches the lane's worktree and role. | `--create-sessions` |
| `inactive_sessions` | A session is dead or has no runtime record. | none (stop/remove via AoE, then `--create-sessions`) |
| `ambiguous` | Multiple pending events, multiple unconfirmed deliveries, or state contradicts the handoff evidence. All candidates are listed; nothing is guessed. | none |
| `blocked` | Lane state is blocked, or an event exceeds `max_rounds`. | none |

Dispatch goes through the same `dispatchLane` path as the watcher, so exactly
one prompt is sent per `--dispatch`, the normal state transitions apply, and
already-dispatched events are never re-sent unless the delivery is
`stale_delivery` and the operator chose to retry it.

A per-lane claim (in the state SQLite store) guarantees one dispatcher per lane:
the watcher's `processLane` and `lane resume --dispatch` both take the claim
before sending, and the stale-delivery path holds it across clearing the journal
marker through the re-dispatch. Claims are ownership-aware leases: while a
dispatch is active (including across an awaited prompt send) the holder renews
the claim, so it never ages into the takeover timeout; a claim genuinely
abandoned by a crashed process is stolen after one minute, and a stale takeover
cannot be undone by the previous owner's delayed release. As a fallback, still
stop the shared watcher before a manual `--dispatch`, especially for a
`stale_delivery`: a concurrently running watcher could otherwise observe the
cleared marker and dispatch the same event.

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

## Re-reviewing feedback on an existing PR

An approved lane stays idle unless OpenCode publishes a new committed
`implementation-response` with boolean `reopen: true`. This is the deliberate
re-entry point for GitHub, CodeRabbit, or user PR feedback. The shared watcher
wakes the lane's Codex session, and normal `changes_requested`/approval handling
continues. Once Codex approves, TARS tells OpenCode to push to the existing PR;
it does not create another PR.

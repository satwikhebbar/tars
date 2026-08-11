---
name: handoff-review
description: >
  Publish and consume file-based review handoffs in .agent-handoff/. Publishes
  plan-review handoffs to wake Codex before implementation, and after
  implementation and commit writes an implementation-response to inbox/ to wake
  the matching Codex review session; consumes Codex plan/code-review handoffs
  through an inbox → in-progress → done/archive pipeline, iterating fix rounds
  until approved. Reads YAML frontmatter for id, workflow_id, round,
  head_commit, target files, requested changes, and acceptance criteria.
license: MIT
---

# Agent Handoff

This repo uses `.agent-handoff/` as a file-based queue for review feedback between agents. OpenCode implements and publishes responses; Codex reviews and returns handoffs. The queue connects the two. **Each lane worktree has its own queue at its own `.agent-handoff/` root — always publish into the current lane worktree's `.agent-handoff/`, never the primary checkout.**

## Review Loop

```text
plan draft → publish plan-review to worktree inbox/ (wakes Codex)
                              │
                              ▼
Codex writes plan-review-verdict to worktree inbox/ (approved | changes_requested)
                              │
                              ▼
implement one scheduled iteration → commit → publish implementation-response to worktree inbox/ (wakes Codex)
                              │
                              ▼
Codex writes code-review handoff to worktree inbox/   (outcome: changes_requested | approved)
                              │
                              ▼
OpenCode claims handoff → applies changes in the same iteration → commits →
publishes next implementation-response (round+1) ─────────► back to Codex
```

## Folder Layout

| Path | Purpose |
|------|---------|
| `.agent-handoff/inbox/` | New handoff files waiting to be processed, plus `plan-review` / `implementation-response` files OpenCode publishes to wake Codex |
| `.agent-handoff/in-progress/` | Files claimed by the implementation agent |
| `.agent-handoff/done/` | Result files written after work is applied |
| `.agent-handoff/archive/` | Processed original handoff files kept for audit history |

Queue contents are gitignored, except `.gitkeep` files and `.agent-handoff/README.md`. The queue lives at the **worktree root** of the lane you are working in — do not publish to the primary checkout's `.agent-handoff/`.

## Publish Plan Review

Publish a `plan-review` handoff only when the TARS opening prompt starts this lane in Plan mode, or when TARS wakes you to revise a plan. A lane explicitly started for direct implementation skips this stage and publishes its first `implementation-response` after its implementation commit.

### When to publish

- After drafting the plan file under `plans/` and before implementing.
- On fix rounds, after consuming a Codex `plan-review-verdict` handoff with `outcome: changes_requested`, applying changes, and committing them.

Do **not** publish for a plan that is not yet written to a file, or for a blocked task.

### File

Write `.agent-handoff/inbox/<id>.md` in the current lane worktree (e.g. `<workflow-id>-plan-review-<round>.md`). The `.agent-handoff/` tree is gitignored — list or check it with `bash ls`, never glob.

### Frontmatter

All coordinator-required fields must be present:

```markdown
---
id: <workflow-id>-plan-review-<round>
type: plan-review
status: ready
created_by: opencode
workflow_id: <lane's issue number>
round: <integer, starting at 1>
head_commit: <full git commit SHA containing the plan>
target:
  - plans/<plan-file>
priority: normal
cleanup: archive
---
```

Field rules:

- `workflow_id` — the lane's GitHub issue number (e.g. `53`). **Keep it identical across all review rounds for one task.**
- `id` — unique per round, e.g. `53-plan-review-1`, `53-plan-review-2`.
- `round` — integer, starting at `1`, incremented by 1 each fix round.
- `head_commit` — the full SHA containing the reviewed plan. Run `git rev-parse HEAD` after committing the plan.

### Body

After the frontmatter:

```markdown
## Summary

Short note on what this round delivers and its status.

## What to Review

- Concrete area of the plan to review.
- Another concrete area.

## Questions for Codex

1. Anything ambiguous or under-specified?
2. Specific design choices to validate.

## Acceptance Criteria

- Observable condition that proves the review happened.

## Context

- Issue URL, related plans, and any constraints.
```

## Publish Implementation for Review

After OpenCode finishes implementation and creates a commit, **publish an `implementation-response` to the current lane worktree's `.agent-handoff/inbox/` before reporting completion.** This is the signal TARS uses to wake the matching Codex review session. Never publish to the primary checkout.

### When to publish

Publish one response per review round:

- **Initial round** — after the implementation commit is created.
- **Fix rounds** — after consuming a Codex `code-review` handoff with `outcome: changes_requested`, applying changes, and committing them.

Do **not** publish an `implementation-response` for:
- uncommitted work (no commit yet);
- failed verification (tests/lint/typecheck not green);
- a blocked task.

For those, use a blocked result/handoff instead (see [Result Shape](#result-shape) and [Behavior Rules](#behavior-rules)).

### File

Write `.agent-handoff/inbox/<id>.response.md`, using the `id` value from the frontmatter as the filename. The `.agent-handoff/` tree is gitignored — list or check it with `bash ls`, never glob. Write it in the **current lane worktree**, never the primary checkout.

### Frontmatter

All coordinator-required fields must be present:

```markdown
---
id: <unique-response-id>
type: implementation-response
status: ready
created_by: opencode
workflow_id: <stable-workflow-id>
round: <integer, starting at 1>
iteration: <integer, starting at 1 when TARS supplied an iteration schedule>
head_commit: <full git commit SHA>
target:
  - <changed paths or task scope>
cleanup: archive
---
```

Field rules:

- `workflow_id` — the stable identifier for the task. **Keep it identical across all review rounds for one task** (e.g. the issue number or branch-based task id).
- `id` — unique per round, e.g. `<workflow-id>-response-<round>` or `<workflow-id>-<round>-<short-topic>`. Never reuse an `id` from a previous round.
- `round` — integer, starting at `1`, incremented by 1 each fix round.
- `iteration` — copy the iteration number from TARS's Build prompt. Keep it unchanged for any fix round within that iteration.
- `head_commit` — the full SHA of the commit this response reports. Run `git rev-parse HEAD` to get it.
- `target` — the changed file paths (relative to repo root) or the task scope.

### Body

After the frontmatter:

```markdown
## Summary

Short note on what this round delivers and its status.

## Changes Made

- Concrete change.
- Another concrete change.

## Verification

- Commands or checks run (e.g. pnpm check, targeted tests) and their results.

## Known Limitations / Questions for Codex

- Anything intentionally skipped, with reason.
- Optional follow-up questions or areas to re-review.
```

## Consuming Codex Review Handoffs

1. **List inbox files using `bash` (NOT `glob`):** run `bash ls -la .agent-handoff/inbox/` in the **current lane worktree** (never the primary checkout). The `.agent-handoff/` tree is gitignored, so glob tools will silently find nothing — you must use bash.
2. Claim one by moving it to `.agent-handoff/in-progress/` via `bash mv`.
3. Read the YAML frontmatter and requested changes.
4. Apply the requested changes to the target files.
5. Verify the acceptance criteria.
6. Write a result file to `.agent-handoff/done/`.
7. For a fix round (`outcome: changes_requested` with changes applied), commit the changes, then publish a new `implementation-response` per [Publish Implementation for Review](#publish-implementation-for-review).
8. Move the original handoff to `.agent-handoff/archive/`, unless its `cleanup` field says `delete`. The `implementation-response` published to `inbox/` is the communication back to Codex and is not archived with the original.

Do **not** process a handoff in `inbox/` whose `id` field duplicates a file already in `in-progress/`, `done/`, or `archive/` — it's a retry or duplicate.

## Handoff Shape

```markdown
---
id: <unique-id>
type: <plan-review-verdict|code-review|etc>
status: ready
created_by: codex
outcome: changes_requested|approved|blocked
target:
  - <file-path>
priority: normal|high
cleanup: archive|delete
---

## Summary

Short review outcome.

## Requested Changes

1. Concrete requested change.
2. Another requested change.

## Acceptance Criteria

- Observable condition that proves the change was made.
```

## Result Shape

```markdown
---
id: <same-as-handoff-id>
status: completed|blocked|failed
completed_by: opencode
---

## Changed

- What changed.

## Files Touched

- `path/to/file`

## Verification

- What was checked.

## Notes

Blockers, follow-ups, or anything left unresolved.
```

Write the `done/` result file **before** moving/archiving the original handoff.

## Fix Rounds

When a consumed handoff has `outcome: changes_requested` (`plan-review-verdict` or `code-review`):

1. Apply the requested changes and verify the acceptance criteria.
2. Commit the changes (`git rev-parse HEAD` after committing gives the new `head_commit`).
3. Increment `round` by 1 from the previous published handoff.
4. Publish the next wake signal to the **current lane worktree's** `.agent-handoff/inbox/`:
- plan-review fix round → a new `plan-review` handoff (same `workflow_id`, new `id`, `round+1`);
   - code-review fix round → a new `implementation-response` (same `workflow_id`, new `id`, `round+1`, new `head_commit`).
5. Leave the original handoff and its result file in `done/`/`archive/` as the record of the consumed round.

Do **not** bump the round or publish a new response when the review is `approved` — that is the terminal state.

For an approved `plan-review-verdict`, record and archive the verdict, then
wait for TARS's `/tars-build` prompt. Implement only the requested iteration
from the verdict's `Implementation Iterations` schedule; do not begin a later
iteration. The terminal-state rule above applies only to an approved final
`code-review`; after each implementation iteration is committed and verified,
publish its `implementation-response` normally.

## Behavior Rules

- Handoff files in `.agent-handoff/*/` are gitignored. Use `bash find` or direct file paths — glob tools respect `.gitignore` and will not find them.
- **Always publish into the current lane worktree's `.agent-handoff/inbox/`, never the primary checkout's `.agent-handoff/`.**
- Process one handoff at a time per session.
- Treat `Requested Changes` as the work queue.
- Treat `Acceptance Criteria` as the definition of done.
- Preserve unrelated user changes — only touch files listed in `target`.
- If blocked or acceptance criteria can't be met, write a `done/` result with `status: blocked` and explain why in `Notes`. Do **not** publish an `implementation-response` for blocked, uncommitted, or unverified work.
- Archive or delete the original handoff according to `cleanup` field. The `implementation-response` published to `inbox/` is a new wake signal for the next round, not a sidecar of the consumed handoff, and is not archived with it.
- Write the result file to `done/` before moving/archiving the original.
- Publish an `implementation-response` only after a commit whose verification passes — never ahead of the commit, and never for a blocked task.
- Keep `workflow_id` identical across all rounds of one task; make every `id` unique per round.
- Never include secrets, absolute personal paths, or local session IDs in handoff or response files.

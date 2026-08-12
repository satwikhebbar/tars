# Protocols

Versioned, tool-neutral handoff formats and lifecycle rules belong here.
Protocols make durable artifacts authoritative and treat delivery mechanisms as
replaceable transports.

## Review loop

TARS treats `.agent-handoff/` as the durable event log:

1. Before implementation, OpenCode may write `plan-review` in the lane
   worktree with `id`, `workflow_id`, and integer `round`. Codex returns
   `plan-review-verdict` with the same correlation fields and `responds_to`.
   `changes_requested` wakes OpenCode to revise the plan; `approved` wakes it
   to implement. An approved verdict carries `iteration_count` and a numbered
   schedule of independently reviewable implementation iterations. A plan
   approval is not a terminal lane state.
2. TARS starts one scheduled iteration at a time. OpenCode commits and writes
   `implementation-response` with `id`,
   `workflow_id` (a stable string or integer issue ID), integer `round`, and
   immutable `head_commit`; scheduled lanes also carry integer `iteration`.
3. The coordinator wakes the matching Codex session.
4. Codex writes `code-review` with the same `workflow_id`, `round`, and
   `iteration` when present, plus `outcome: approved`, `changes_requested`,
   or `blocked`.
5. Only `changes_requested` wakes OpenCode. Its next committed response uses
   the next round in the same iteration. An approved non-final iteration wakes
   OpenCode for the next iteration; only final approval and `blocked` are
   terminal.
6. An approved lane may be deliberately reopened for feedback on its existing
   pull request. OpenCode commits the feedback changes and writes a new
   `implementation-response` with `reopen: true`. The coordinator accepts only
   this explicit marker from an approved lane, wakes Codex, and returns to the
   normal code-review loop. A renewed approval updates the existing PR; it
   never creates a second one.

Queue state, AoE session IDs, and handoff contents stay outside TARS.

# Protocols

Versioned, tool-neutral handoff formats and lifecycle rules belong here.
Protocols make durable artifacts authoritative and treat delivery mechanisms as
replaceable transports.

## Review loop

TARS treats `.agent-handoff/` as the durable event log:

1. OpenCode commits and writes `implementation-response` with `id`,
   `workflow_id` (a stable string or integer issue ID), integer `round`, and
   immutable `head_commit`.
2. The coordinator wakes the matching Codex session.
3. Codex writes `code-review` with the same `workflow_id` and `round`, plus
   `outcome: approved`, `changes_requested`, or `blocked`.
4. Only `changes_requested` wakes OpenCode. Its next committed response uses
   the next round. `approved` and `blocked` are terminal.

Queue state, AoE session IDs, and handoff contents stay outside TARS.

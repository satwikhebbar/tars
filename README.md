# TARS

TARS is the shared home for the skills, protocols, and automation we use to coordinate local coding agents across projects.

Today, its primary workflow is a per-worktree implementation and review lane: OpenCode makes and commits a change; Codex reviews that immutable commit; OpenCode addresses any requested changes; and, once approved, OpenCode pushes the branch and creates a pull request. Agent of Empires (AoE) wakes the right existing session at each transition, while file-based handoffs preserve the durable workflow record.

## Contents

- [`automations/`](automations/): runnable orchestration tools. The review loop registers one OpenCode/Codex AoE pair per worktree and manages their review iterations.
- [`skills/`](skills/): canonical, agent-specific skill packages. Install them globally so fresh AoE sessions can use them immediately.
- [`protocols/`](protocols/): versioned coordination contracts, including the `.agent-handoff/` review lifecycle.

## Current review-loop lifecycle

```text
OpenCode implements and commits
  → implementation-response handoff
  → Codex review
  → code-review handoff
  → OpenCode fixes and commits (when changes are requested)
  → repeat until approved
  → OpenCode pushes the branch and creates a PR
```

The coordinator is intentionally project-agnostic: it orchestrates sessions and handoffs, but it does not contain the code or task-specific context for the projects being worked on. As we add other multi-agent workflows, their reusable skills, protocols, and automation belong here too.

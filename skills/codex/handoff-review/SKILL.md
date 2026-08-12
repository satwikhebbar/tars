---
name: handoff-review
description: Create file-based review handoffs for another local coding agent such as Opencode. Use when Codex is asked to review a plan, implementation plan, code changes, diff, pull request, repository state, or an OpenCode implementation-response, including when the TARS review loop wakes Codex to review a committed implementation and publish its verdict.
---

# Handoff Review

Use this skill to turn review feedback into a concrete handoff file in the current repository.

## Workflow

1. Discover and review any prior agent responses that may affect the requested artifact.
2. Review the requested artifact normally: plan, spec, code diff, branch, or files.
3. Create `.agent-handoff/` if it does not exist, with `inbox/`, `in-progress/`, `done/`, and `archive/`.
4. Ensure transient handoff contents are ignored by git while `.gitkeep` files and `.agent-handoff/README.md` can be tracked.
5. Write one Markdown file to `.agent-handoff/inbox/`.
6. In the final response, summarize the review and mention the handoff file path.

Do not move files into `in-progress/`, `done/`, or `archive/` yourself unless the user asks you to act as the implementation agent. The consuming agent owns claiming, completion, and cleanup.

## TARS Review-Loop Requests

When an AoE/TARS coordinator asks for a plan review, it supplies the path to a
`plan-review` handoff. Read that handoff and its target plan artifact. Write
exactly one `plan-review-verdict` handoff to the current lane worktree's
`.agent-handoff/inbox/`; copy `workflow_id` and `round`, set `responds_to` to
the request `id`, and set `outcome` to exactly one of `approved`,
`changes_requested`, or `blocked`. Do not implement the plan or edit
implementation files.

For an approved plan, include a numbered `implementation_iterations` schedule
in the verdict body and set `iteration_count` in the frontmatter to the same
positive integer. Make each iteration independently buildable, testable, and
small enough for one commit and review. Use one iteration when splitting would
not improve reviewability. For every iteration, name its scope, acceptance
criteria, and verification. Request plan changes when the proposed order would
leave an unsafe intermediate state.

When an AoE/TARS coordinator asks for a code review, it supplies the path to
an `implementation-response` and its immutable `head_commit`. Read that
handoff, review exactly that commit, and do not edit implementation files.

Treat the implementation response's `Verification` section as review evidence.
In repositories where the handoff states that lefthook gates every commit,
successful test, lint, and Biome checks there are the baseline validation for
that commit: inspect the recorded commands and results, but do not routinely
rerun the same broad checks. Run a focused check only when validation is
missing, failed or does not cover the changed risk, or when the review finds a
specific behavior that needs confirmation. Record any additional validation in
the verdict.

Write exactly one `code-review` handoff to `.agent-handoff/inbox/`. Copy
`workflow_id` and `round` unchanged from the implementation response, set
`responds_to` to its `id`, and set `outcome` to exactly one of `approved`,
`changes_requested`, or `blocked`. Do not move, archive, or delete the
implementation response, and do not create another review handoff for it.

Copy `iteration` unchanged when the implementation response carries it. Review
only that scheduled iteration; approval permits TARS to start the next one or,
for the final iteration, to create the pull request.

For `changes_requested`, include concrete requested changes and acceptance
criteria. For `approved`, explicitly state that no changes are required. For
`blocked`, state the blocking condition and what is needed to proceed.

## File Naming

Use a stable, sortable name:

```text
.agent-handoff/inbox/YYYY-MM-DD-short-topic.md
```

Examples:

```text
.agent-handoff/inbox/2026-07-10-plan-review.md
.agent-handoff/inbox/2026-07-10-code-review-linkedin-auth.md
```

If a file already exists, append a short suffix such as `-2` or include the target area.

Every review run needs a unique ID; append a suffix for re-reviews, including when an earlier handoff is in another worktree.

## Agent Responses

The consuming agent may optionally leave a response sidecar after applying a handoff. Codex should read these responses before creating a later review when they match the current target or respond to a prior related handoff.

Response sidecars use the original handoff id plus `.response.md`:

```text
.agent-handoff/done/YYYY-MM-DD-short-topic.md
.agent-handoff/done/YYYY-MM-DD-short-topic.response.md
```

Response sidecars usually live in `done/` while awaiting review, then move with the original handoff into `archive/` during cleanup. Do not edit, move, or delete response sidecars unless the user asks you to act as the implementation or cleanup agent.

Before writing a new handoff, scan these locations when present:

```text
.agent-handoff/done/*.response.md
.agent-handoff/archive/*.response.md
```

Prefer `rg --files` for discovery, not `find`:

```bash
rg --files .agent-handoff/done .agent-handoff/archive | rg '\.response\.md$'
```

If a response is expected but no files are returned, list both directories before concluding none exist:

```bash
ls .agent-handoff/done .agent-handoff/archive
```

If the user or another agent mentions an exact response path, read that path directly even if discovery did not find it. Treat archived response sidecars as active context for future reviews when their target overlaps the current work.

Read response files when:

- `responds_to` matches a prior handoff id for the same work.
- `target` overlaps the current review target.
- `Questions For Codex`, `Not Done`, or `Verification` may affect the current review.

If a new handoff follows up on a response, include `related_to` in the frontmatter:

```yaml
related_to:
  - prior-handoff-id
  - prior-response-id
```

## Handoff Format

Use this shape:

```markdown
---
id: YYYY-MM-DD-short-topic
type: plan-review # Use code-review for a TARS review-loop verdict.
status: ready
created_by: codex
target:
  - path/or/topic
priority: normal
cleanup: archive
---

## Summary

One short paragraph explaining the review outcome.

## Requested Changes

1. Specific change with enough context for the implementation agent.
2. Another specific change.

## Acceptance Criteria

- Observable condition that proves the change was made.
- Relevant tests, docs, or verification notes.

## Context

Optional notes, links, or source references that help the implementation agent avoid rediscovery.
```

For a TARS code-review verdict, use this frontmatter instead of the generic
example above:

```markdown
---
id: YYYY-MM-DD-short-topic-review
type: code-review
status: ready
created_by: codex
workflow_id: stable-workflow-id
round: 1
iteration: 1 # copy from the implementation response when present
outcome: changes_requested # approved | changes_requested | blocked
responds_to: implementation-response-id
target:
  - path/or/topic
priority: normal
cleanup: archive
---
```

For a TARS plan-review verdict, use:

```markdown
---
id: YYYY-MM-DD-short-topic-plan-verdict
type: plan-review-verdict
status: ready
created_by: codex
workflow_id: stable-workflow-id
round: 1
outcome: changes_requested # approved | changes_requested | blocked
responds_to: plan-review-request-id
iteration_count: 2 # required when outcome is approved
target:
  - plans/the-plan.html
priority: normal
cleanup: archive
---

## Implementation Iterations

1. **Iteration 1 — concise title**
   - Scope: paths and behavior included in this commit.
   - Acceptance criteria: observable completed behavior.
   - Verification: commands or tests.
2. **Iteration 2 — concise title**
   - Scope: paths and behavior included in this commit.
   - Acceptance criteria: observable completed behavior.
   - Verification: commands or tests.
```

Valid `type` values:

- `plan-review`
- `plan-review-verdict`
- `code-review`
- `implementation-feedback`
- `follow-up`

Response sidecars may use:

- `implementation-response`

Use `cleanup: archive` by default. Use `cleanup: delete` only when the user explicitly wants no audit trail.

## Response Format

Consuming agents may use this shape:

```markdown
---
id: YYYY-MM-DD-short-topic-response
type: implementation-response
status: done
created_by: opencode
responds_to: YYYY-MM-DD-short-topic
target:
  - path/or/topic
cleanup: archive
---

## Summary

Short note on what changed.

## Changes Made

- Concrete change.

## Not Done

- Anything intentionally skipped, with reason.

## Verification

- Commands or checks run.

## Questions For Codex

- Optional follow-up questions or areas to re-review.
```

## Writing Review Feedback

Keep handoffs actionable:

- Prefer concrete requested changes over broad critique.
- Include target files or sections when known.
- Preserve severity by ordering the highest-risk items first.
- Add acceptance criteria that an agent can verify locally.
- Include blockers or open questions only when they affect implementation.

For code reviews, lead with bugs, regressions, missing tests, or operational risks. For plan reviews, lead with architecture, sequencing, scope, and verification gaps.

## Repo Setup Snippet

If the handoff structure is missing, create:

```text
.agent-handoff/
  README.md
  inbox/.gitkeep
  in-progress/.gitkeep
  done/.gitkeep
  archive/.gitkeep
```

Add these ignore rules if absent:

```gitignore
# Local agent handoff queues
.agent-handoff/inbox/*
.agent-handoff/in-progress/*
.agent-handoff/done/*
.agent-handoff/archive/*
!.agent-handoff/inbox/.gitkeep
!.agent-handoff/in-progress/.gitkeep
!.agent-handoff/done/.gitkeep
!.agent-handoff/archive/.gitkeep
```

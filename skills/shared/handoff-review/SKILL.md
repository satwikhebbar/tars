---
name: handoff-review
description: Publish or consume durable TARS review handoffs in .agent-handoff/. Use when acting as a lane author or reviewer, reviewing plans or commits, or responding to a TARS coordinator prompt.
---

# TARS Handoff Review

The current lane uses `.agent-handoff/` as a durable queue. Work only in the current lane worktree. TARS assigns your role in its prompt.

## Author

For the first author handoff, copy `workflow_id`, `round`, and any assigned
`iteration` from the opening prompt. Use the templates and
`tars handoff validate --path <handoff-file>` for handoff mechanics; if the
prompt lacks `workflow_id`, ask the coordinator for it. Keep metadata lookup in
the prompt and current lane; shared source and runtime folders are not lookup
paths. Read current-lane handoffs only when determining a later round, response
target, or assigned iteration.

- After committing verified code, write an implementation-response draft outside `.agent-handoff/` and omit `head_commit`. Run `tars handoff publish --file <draft-path>` from the lane worktree. The command inserts the full SHA from Git HEAD, validates, and atomically publishes to `.agent-handoff/inbox/<id>.md`; success prints the published path. Use a new id for a later response.
- Publish plan handoffs as Markdown in `.agent-handoff/inbox/` after committing the plan. The coordinator reads Markdown frontmatter; use the matching template below rather than a JSON file.
- Set `created_by: author`; preserve `workflow_id`, increment `round`, and copy any assigned `iteration`. Before publishing, run `tars handoff validate --path <handoff-file>` and correct every reported error.
- When changes are requested, consume the reviewer handoff, make and verify the requested change, commit, then publish the next author response.
- For feedback on an already-approved pull request, include `reopen: true` in the implementation response. It reopens the lane and routes the response to the reviewer.

### Implementation response

```markdown
---
id: issue-<number>-implementation-<round>
type: implementation-response
status: ready
created_by: author
workflow_id: <workflow-id>
round: <round>
# Include this field only for a plan-first lane:
iteration: <iteration>
# Include for feedback on an already-approved pull request:
reopen: true
# tars handoff publish inserts head_commit from Git HEAD.
cleanup: archive
---

## Summary

## Verification
```

### Plan review

```markdown
---
id: issue-<number>-plan-review-<round>
type: plan-review
status: ready
created_by: author
workflow_id: <workflow-id>
round: <round>
target:
  - plans/<plan-file>.md
cleanup: archive
---

## Summary
```

## Reviewer

- For a plan request, write exactly one `plan-review-verdict`; for an implementation response, write exactly one `code-review`.
- Set `created_by: reviewer`, copy `workflow_id`, `round`, `iteration` when supplied, and set `responds_to` to the request id. Before publishing, run `tars handoff validate --path <handoff-file>` and correct every reported error.
- Use outcome `approved`, `changes_requested`, or `blocked`. An approved plan must include positive `iteration_count`, a numbered implementation-iterations schedule, and the review budget the implementation may consume: either `review_budget <total>` or `review_budget_per_iteration <allowance>` (allowance × `iteration_count`).
- Review only the requested plan or immutable commit. Do not edit implementation files.

### Code review method

For an `implementation-response`, read and follow [CODE-REVIEW.md](references/CODE-REVIEW.md) before reviewing the commit.

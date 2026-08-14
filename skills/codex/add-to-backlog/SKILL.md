---
name: add-to-backlog
description: Capture a new backlog item as a GitHub issue on the current repo. Use when the user says "add to backlog", "create an issue", "file an issue", or describes a bug, idea, or improvement they want tracked for later.
---

# Add to Backlog

Turn a rough concern or idea into a GitHub issue on the current repo.

## What the issue is (and is not)

The issue is NOT a full spec — specs happen later in a separate planning
phase. Capture only enough that a future reader knows why the issue was
created and what goal it aims to achieve. Do not include implementation
plans or solution designs.

## Workflow

1. Verify the user's claims against the codebase; ask brief follow-ups only if needed. State findings with durable references before drafting.
2. Draft: action-oriented **title**; description = current state + **Problem** + **Goal**. Goal may be subjective or objective — propose one if the user didn't.
3. Get user confirmation on the draft.
4. `rtk gh issue create --title "..." --body "..."`, reply with the URL.

## Rules

- Do not break issues into sub-issues; that belongs to the planning skill. Only major multi-phase features are exceptions, and even those are split during planning, not here.

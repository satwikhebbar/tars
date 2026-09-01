# Manual Test Plan

Automated coverage is green. Complete these real-integration checks before shipping.

- [x] Run `node setup.mjs`; verify only installed AoE harnesses are offered, defaults persist, and selected harnesses receive their skills. (2026-08-19: Claude Code selected for both roles; all five shared skills installed.)
- [x] Run an OpenCode author → Codex reviewer direct-build lane through review, approval, and PR creation.
  - Completed (2026-08-19): issue 1 completed review, approval, and PR #5. The lane will be closed by the user after the remaining manual checks.
  - Confirmed (2026-08-20): `--planning never` now starts OpenCode directly in implementation without a planning-choice prompt. The direct-build opening prompt and shared kickoff contract require immediate implementation.
- [x] Run an OpenCode author → Codex reviewer plan-first lane through plan approval and Build transition. (2026-08-20: Issue 2 required two review revisions; the third reviewer verdict approved the plan with `created_by: reviewer`, and TARS advanced the lane to `implementing`.)
- [x] Run a Claude author → Codex reviewer lane; verify role prompts and `created_by: author` / `created_by: reviewer` handoffs. (2026-08-20: Issue 3 produced a valid author response, Codex requested one focused change, then approved the revision. TARS reached `approved`.)
  - Use a small, independent issue whose implementation can be accepted; do not use an issue that overlaps an actively changing workflow. The prior Issue 2 attempt was discarded for this reason.
- [x] Run a Codex author → OpenCode reviewer lane; verify the reverse role mapping without relying on Claude's current authentication and auto-mode limitations. (2026-08-20: Issue 3 completed a `changes_requested` round followed by approval. Both Codex author handoffs carried `created_by: author`; both OpenCode verdicts carried `created_by: reviewer`. Codex launched with `--approve-for-me`.)
- [ ] Run a Codex author → Claude reviewer lane when Claude's subscription authentication supports an unattended reviewer session; verify Claude in the reviewer role.
- [x] Run a same-harness lane using separate author and reviewer sessions. (2026-08-20: Codex → Codex on Issue 3 completed a `changes_requested` round followed by approval. TARS kept the two Codex session IDs role-bound, and handoffs retained `created_by: author` / `created_by: reviewer`.)
- [ ] With Cursor installed, run a Cursor lane; verify `.cursor/rules/tars.mdc` is worktree-local, Git-ignored, and applied by Cursor.
- [x] Configure an unavailable harness; verify lane start fails before creating a worktree or AoE session. (2026-08-20: `--author cursor` failed because Cursor is not installed in AoE; the worktree list was unchanged.)
- [x] Create an unowned skill or Cursor rule at a destination; verify provisioning refuses to overwrite it without explicit force. (2026-08-20: installation refused the pre-existing unowned `~/.codex/skills/handoff-review`.)
- [ ] Run a multi-iteration plan-first lane whose reviewer repeatedly returns `changes_requested`; verify the lane blocks with reason `review_budget` only after the approved plan's budget (or `review_budget_per_iteration` × `iteration_count`) is consumed, that ordinary approvals and iteration advances never consume it, and that `tars lane set-max-rounds --worktree <path> --review-budget <n> --resume` recovers the lane without resetting the consumed counter.

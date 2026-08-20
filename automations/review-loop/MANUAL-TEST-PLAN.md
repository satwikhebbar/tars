# Manual Test Plan

Automated coverage is green. Complete these real-integration checks before shipping.

- [x] Run `node setup.mjs`; verify only installed AoE harnesses are offered, defaults persist, and selected harnesses receive their skills. (2026-08-19: Claude Code selected for both roles; all five shared skills installed.)
- [ ] Run an OpenCode author → Codex reviewer direct-build lane through review, approval, PR creation, and lane close.
  - Completed through approval and PR creation (2026-08-19): issue 1 completed review, approval, and PR #5. Lane close remains pending while that PR is under review.
  - Confirmed (2026-08-20): `--planning never` now starts OpenCode directly in implementation without a planning-choice prompt. The direct-build opening prompt and shared kickoff contract require immediate implementation.
- [ ] Run an OpenCode author → Codex reviewer plan-first lane through plan approval and Build transition.
- [ ] Run a Claude author → Codex reviewer lane; verify role prompts and `created_by: author` / `created_by: reviewer` handoffs.
- [ ] Run a Codex author → Claude reviewer lane; verify the reverse role mapping.
- [ ] Run a same-harness lane (for example Claude → Claude) using explicit author and reviewer session IDs.
- [ ] With Cursor installed, run a Cursor lane; verify `.cursor/rules/tars.mdc` is worktree-local, Git-ignored, and applied by Cursor.
- [ ] Configure an unavailable harness; verify lane start fails before creating a worktree or AoE session.
- [ ] Create an unowned skill or Cursor rule at a destination; verify provisioning refuses to overwrite it without explicit force.

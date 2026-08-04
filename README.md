# TARS

Public-safe skills, protocols, and automation for coordinating local coding agents across projects.

This repository must never contain credentials, provider tokens, local agent transcripts, worktree handoff contents, personal state databases, or project-private source code. Runtime state belongs outside the repository.

## Contents

- [`automations/`](automations/): runnable local orchestration tools, including the per-worktree AoE review loop.
- [`skills/`](skills/): portable skill definitions.
- [`protocols/`](protocols/): versioned, tool-neutral coordination contracts.

# Skills

TARS is the canonical, public-safe source for reusable skills. Keep one
agent-specific package per skill at `skills/<agent>/<skill>/`; do not edit
installed copies directly.

Install a packaged skill explicitly:

```bash
node skills/install.mjs codex handoff-review --force
node skills/install.mjs opencode handoff-review --force                 # global: ~/.config/opencode/skills
node skills/install.mjs opencode handoff-review --worktree <path> --force  # per-worktree: <path>/.opencode
```

OpenCode skills default to the global `~/.config/opencode/skills/` directory.
Install there so every project and worktree has the skills — a bootstrap skill
like `issue-kickoff` must exist globally, otherwise a fresh worktree has no
skill to provision it (catch-22). `--worktree` targets a single checkout when
you need a self-contained or versioned-pinned copy.

The installer refuses to replace an existing installation unless `--force` is
given. It copies the selected package into the destination, so updating TARS
does not silently change a running agent. Re-run the install command whenever
you want a local agent or worktree to receive a versioned update.

Only commit portable instructions and generic examples. Never commit
credentials, provider tokens, local session IDs, agent transcripts, runtime
state, project-private source, or live handoff contents.

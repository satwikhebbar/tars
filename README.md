# TARS

TARS is the shared home for local multi-agent orchestration: reusable skills,
durable handoff protocols, and automation that coordinate OpenCode and Codex
through Agent of Empires (AoE).

Its current workflow creates one lane per git worktree. OpenCode implements;
Codex reviews immutable commits; TARS wakes the correct existing session until
the approved branch is ready for a pull request.

## Prerequisites

Before continuing, make sure the following commands are available in the
environment where AoE launches agent sessions:

- A recent [Node.js runtime](https://nodejs.org/en/download) with `node:sqlite`
  support.
- [tmux](https://github.com/tmux/tmux/wiki/Installing) and
  [Agent of Empires (AoE)](https://github.com/agent-of-empires/agent-of-empires/blob/main/docs/installation.md)
  installed and usable as `aoe`. AoE's tmux-backed sessions must be able to
  launch both `opencode` and `codex` from their environment.
- [OpenCode](https://opencode.ai/docs) and
  [Codex](https://learn.chatgpt.com/docs/codex/cli) installed and authenticated.
  If Codex comes from the ChatGPT desktop app, expose its executable on `PATH`
  before launching AoE.
- [GitHub CLI (`gh`)](https://cli.github.com/manual/) authenticated for the
  target project; `lane start` reads the issue title and body.
- A target Git repository whose OpenCode global skills describe how to work its
  issues (for example, its issue-kickoff workflow).

## One-time setup

Clone TARS and install the skills and command used by fresh agent sessions:

```bash
git clone https://github.com/satwikhebbar/tars.git
cd tars

node skills/install.mjs codex handoff-review --force
node skills/install.mjs codex add-to-backlog --force
node skills/install.mjs opencode handoff-review --force
node skills/install.mjs opencode issue-kickoff --force
node skills/install.mjs opencode address-pr-feedback --force
node commands/install.mjs opencode tars-build --force
```

Install any other OpenCode skills your project uses in the same way, for
example `close-issue` or `add-to-backlog`. The installer copies a version into
the agent's global configuration, so re-run it after pulling future skill
updates. Start new AoE sessions after an update; an already-running agent may
still have its earlier skill instructions in context.

## Start using TARS

Run one long-lived watcher from the TARS checkout. It serves every registered
lane and prints only dispatched handoff events, so quiet output means no new
handoff needed delivery.

```bash
node automations/review-loop/cli.mjs watch
```

In another terminal, create a lane for an issue. TARS asks OpenCode for a
bounded branch/worktree suggestion, lets AoE create the worktree and sessions,
then sends OpenCode the appropriate opening prompt:

```bash
node automations/review-loop/cli.mjs lane start \
  --repo /absolute/path/to/main-checkout \
  --issue 44 \
  --planning auto
```

Use `--planning always` to require a plan-first lane, or `--planning never`
for direct implementation. A plan-first lane can use a configured planning
model:

```bash
node automations/review-loop/cli.mjs lane start \
  --repo /absolute/path/to/main-checkout \
  --issue 44 \
  --planning always \
  --plan-model <provider/model>
```

TARS prints the worktree path, OpenCode session ID, Codex session ID, and
branch. Use AoE's normal tmux interface to observe either session; do not
create a second implementer session for the same lane.

## Review-loop lifecycle

```text
Plan-first lane

OpenCode plan → plan-review handoff → Codex plan review
  → approved verdict + ordered iteration schedule
  → TARS compacts OpenCode and starts iteration 1 in Build mode
  → commit + implementation-response → Codex code review
      → changes requested: revise and re-review the same iteration
      → approved before final iteration: TARS starts the next iteration
      → final approval: OpenCode pushes the branch and creates the PR

Direct-build lane

OpenCode commit → implementation-response → Codex code review
  → changes requested: revise, commit, and repeat
  → approved: OpenCode pushes the branch and creates the PR

Existing PR feedback

You ask OpenCode to use `address-pr-feedback` → it commits a marked follow-up
handoff → TARS reopens only that approved lane for Codex review
  → changes requested: normal repair/review loop
  → approved: OpenCode pushes the reviewed follow-up to the existing PR
```

Codex uses an approved plan verdict to recommend the smallest sensible set of
independently buildable and testable iterations. TARS stores the current
iteration per worktree, so multiple plan-first and direct-build lanes can
advance concurrently without crossing handoffs.

After you or a GitHub-integrated reviewer leaves feedback on an approved PR,
ask the lane's existing OpenCode session to use `address-pr-feedback`. It reads
the existing PR feedback, commits and publishes an explicit reopen handoff, and
leaves delivery to the shared watcher. No second lane or pull request is made.

## Day-to-day lane commands

```bash
# Inspect all persisted lanes.
node automations/review-loop/cli.mjs status

# Register an already-created AoE OpenCode/Codex pair; the shared watcher serves it.
node automations/review-loop/cli.mjs lane register --worktree /absolute/path/to/worktree

# Start a one-off watcher while registering an existing pair (advanced use).
node automations/review-loop/cli.mjs start --worktree /absolute/path/to/worktree

# Retire a merged, approved lane. AoE removes its own worktree and branch.
node automations/review-loop/cli.mjs lane close --issue 44

# Abort only after both registered AoE panes have been stopped and are dead.
node automations/review-loop/cli.mjs lane close --issue 44 --force
```

See the [review-loop reference](automations/review-loop/README.md) for all
flags, persisted state, and handoff metadata. The canonical skill packages are
under [`skills/`](skills/), and the tool-neutral handoff contract is under
[`protocols/`](protocols/).

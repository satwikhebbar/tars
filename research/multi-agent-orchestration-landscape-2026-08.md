# Multi-agent coding orchestration landscape

Research date: 2026-08-17  
Status: first working draft — intended to be revised after a short, hands-on evaluation.

## Executive conclusion

TARS is not simply recreating Agent of Empires (AoE).  It uses AoE as an
*execution substrate* (sessions, worktrees, terminal delivery) and adds a
*workflow policy layer*: an OpenCode implementer and a Codex reviewer exchange
durable, correlated handoffs; a coordinator enforces review gates, iterations,
idempotent delivery, and PR/reopen rules.

However, TARS does reimplement some **session/worktree lifecycle** that AoE
already provides.  That overlap deserves a deliberate thinning pass.  Orca is
the strongest currently visible alternative if the desired product is a
worktree-native, visual command centre with native task/run/worker concepts.
Its orchestration feature is explicitly experimental, so it should be evaluated
as a promising control plane—not assumed to replace TARS's policy engine.

The useful architecture boundary is:

```text
issue / PR / team conventions
          │
TARS: role-aware review & delivery policy     ← remains valuable
          │
AoE / Orca / Conductor: sessions, worktrees, UI, isolation, observability
          │
Git worktree, agent CLIs, containers, remote machines
```

“Lane” is therefore overloaded.  In TARS, it is a persisted workflow with two
roles and state.  In Orca, the closest native pieces are a worktree plus (for
supervised work) a Run/Task/Dispatch.  In AoE, a group is an organizational UI
bucket; its sessions are independent.  We should not equate these concepts
without deciding which semantic level we need.

## Scope and evaluation method

This compares tools that can help run several coding agents and/or isolated
code changes in parallel.  It does *not* treat “can launch an LLM” as adequate
evidence of multi-agent orchestration.

### Confirmed decision frame

This evaluation is for a **local, terminal-first** operating model.  Cloud
hosting is a later deployment concern once local workflows have proved stable,
not a direct substitute in this comparison.  Replacing either AoE or TARS is
in scope: this is a fast-moving, nascent category and existing architecture is
not presumed permanent.

Priorities, in order, are:

1. Human observability and control.
2. Low operational complexity.
3. Reliable review/approval loops, with a small GitHub issue backlog used to
   record TARS improvements for later implementation.
4. Parallel throughput; it is required for more than one concurrent task, but
   not sufficient on its own.

Accordingly, a tool that starts more agents but makes ownership, review state,
recovery, or the next operator action harder to see should score poorly.

### Concrete TARS workflow work currently parked

The comparison must be tested against two open TARS issues, not an abstract
notion of a backlog:

1. [#2: Support human-gated iteration checkpoints](https://github.com/satwikhebbar/tars/issues/2).
   Today, TARS automatically advances a plan-first lane after Codex approves
   each non-final implementation increment.  The proposed optional mode would
   pause at that point, make the approved increment reviewable in a draft PR,
   and require an operator to explicitly continue the *same* lane.  The default
   remains fully automated.
2. [#1: Add safe lane resume and recovery](https://github.com/satwikhebbar/tars/issues/1).
   Today, an interrupted or stale coordinator can leave a lane needing manual
   SQLite inspection or prompt reconstruction.  The proposed recovery flow
   must derive the next action from durable handoffs and lane state, avoid a
   duplicate dispatch, clearly expose ambiguity/inactive sessions, and require
   explicit operator intent before it acts.

These set two non-negotiable evaluation scenarios.  A prospective outer
harness must either provide them natively with durable evidence, or make it
straightforward for TARS's small policy layer to provide them without fragile
UI automation.  In particular, a generic issue watcher/dispatcher is **not**
an answer to the GitHub-issues requirement: the issues record product work;
they do not authorize autonomous continuation of an uncertain lane.

### Newly identified delivery and planning scenarios

The next iteration of the evaluation is no longer just “can several agents
work in isolated worktrees?”  It must cover four additional, human-governed
scenarios:

1. **Post-hoc PR decomposition.**  Given one large implementation branch/PR,
   derive a *reviewable dependency stack*—small logical branches and PRs whose
   bases preserve dependencies—without silently dropping, reordering, or
   changing the generated work.  A human reviewer other than the author should
   be able to review and approve each layer independently.
2. **Deliberate planning.**  Before implementation, an optional planning mode
   should actively challenge an initial request: surface ambiguity, invariants,
   failure modes, migrations, API compatibility, tests, observability, rollout
   and rollback.  “Grilling” describes a prompt/role and an approval protocol,
   not a capability that a worktree manager can supply by itself.
3. **Human-shaped increments.**  The author may define, merge, split, reorder
   or reject proposed iteration boundaries before execution.  The agent may
   propose a decomposition, but it must not become the lane's execution DAG
   merely because it is plausible.
4. **External-feedback continuation.**  A new human or CodeRabbit PR comment,
   review state, or unresolved review thread must become a durable, deduplicated
   work item.  It may *offer* a governed follow-up iteration, but must not
   silently dispatch an agent, mutate a branch, resolve a comment, or represent
   approval.  The follow-up needs the same worktree-level review handoff and
   explicit approval gate as an original iteration.

These are distinct requirements.  A stacked-PR tool makes review slices easier
but does not decide whether the slices are semantically valid; a PR webhook
reports new feedback but does not authorize code changes; and a planning agent
can ask excellent questions but cannot decide business trade-offs for the
author.

The assessment uses four separate dimensions:

| Dimension | Question |
| --- | --- |
| Isolation | Can workers safely have independent files, branches, environment setup, and optionally compute? |
| Control plane | Can we create, observe, resume, stop, and clean up workers/worktrees? |
| Coordination | Is there durable task ownership, messaging, dependency/DAG support, acknowledgements, and recovery? |
| Delivery governance | Can it enforce our specific plan → immutable commit → review → PR/reopen policy? |

Product “maturity” below is deliberately qualitative.  It reflects documented
scope and explicit stability statements, not a claim about enterprise
reliability, vendor longevity, or independent benchmark performance.

## Shortlist

| Option | Category | Maturity signal | Relevant capability | Bottom line |
| --- | --- | --- | --- | --- |
| **AoE** | Open-source local session/worktree manager | Broad documented CLI and MIT license; CityHall team server is explicitly experimental | Heterogeneous agents, git worktrees, optional Docker, TUI/web, JSON CLI, ACP | Keep as the current substrate; use more of it before replacing it. |
| **AWS CLI Agent Orchestrator (CAO)** | Open-source local, cross-provider agent coordinator | Apache-2.0 AWS Labs project, actively versioned, with a local server and REST/MCP/CLI control planes | Supervisor/worker handoff, async assignment, inbox messaging, workflow journal/resume, provider profiles, terminal restore and per-role tool restrictions | The most important omitted comparator.  Stronger coordination than AoE, but it **does not yet provide provider-neutral worktree isolation**—an open AWS issue identifies that gap. |
| **Orca** | Commercial worktree-native agent IDE/control plane | Broad local/remote docs; its orchestration layer is explicitly experimental | Worktree-first UX, multi-agent launches, Runs/Tasks/Dispatches, messaging, decision gates, SSH and browser per worktree | Best direct evaluation candidate for a native “lane” control surface. |
| **Groundcrew** | Open-source local task dispatcher | MIT project with task-source adapters and sandbox-by-default operating model | Watches assigned Linear/Jira/local tasks, routes to real CLI agents, one worktree per task, tmux/cmux/zellij, Docker/Safehouse | A distinct issue-to-worker operating model, not a direct answer to TARS's manually curated GitHub improvement backlog; it lacks evidence of a durable reviewer state machine. |
| **Vibe Kanban** | Open-source local Kanban/worktree agent control plane | Public source project; the original project is sunsetting and continuing community-maintained, so operational maturity needs a trial | Task board, per-task worktree/branch/session, setup scripts, multi-repo workspaces, monitoring/review | Strong human observability at low conceptual cost; primarily task/workspace management rather than inter-agent protocol. |
| **dmux** | Open-source terminal-first worktree multiplexer | MIT, documented release/project activity and a deliberately narrow terminal UX | tmux panes, one worktree/branch per pane, multi-agent launch, attach/resume, hooks, merge/PR actions | Most compelling low-complexity terminal replacement for AoE's *workspace* layer; it does not coordinate review roles or workflow state. |
| **Overstory** | Open-source autonomous coding-team orchestrator | Broad documented architecture, but adapter stability is explicitly mixed (only Claude/Sapling marked stable) | Worktrees, SQLite typed mail, role restrictions, merge queue, watchdogs, checkpoints, Web UI/tmux escape hatch | The most feature-complete workflow-engine comparison; potentially overlaps TARS deeply, but is materially more complex and not yet a proven OpenCode+Codex fit. |
| **Conductor** | Desktop workspace/worktree control plane | First-class workspace lifecycle and agent integrations in its docs | Worktree + branch + chat + setup/test + diff/PR/archive | Good alternative visual shell; does not itself prove role-aware workflow governance. |
| **Claude Code** | Agent-native coordination plus worktrees | Worktrees are documented product functionality; Agent Teams are experimental and disabled by default | Lead/teammates, shared task list, direct messages, worktree-isolated subagents | Strong for same-provider exploratory collaboration, not a direct heterogeneous replacement. |
| **Codex app** | Native parallel-agent desktop workspace | Product docs say workflows are still being refined | Parallel threads/projects, isolated worktrees, diff review, skills and automations | Worth using directly for Codex-heavy lanes; it does not document TARS's cross-tool state machine. |
| **GitButler** | Alternative VCS workspace model | Documented parallel-agent workflow | Parallel virtual branches and hunk attribution in one checkout | Useful experiment when duplicated worktrees are the bottleneck; weaker isolation by design. |

### 1. Agent of Empires (AoE): the current substrate

AoE is an MIT-licensed Rust/tmux session manager.  Its official site describes
parallel worktrees, optional Docker sandboxing, TUI and web control surfaces,
and support for Claude Code, Codex, OpenCode, Gemini CLI and others.  Its CLI
has machine-readable session listing/status, session lifecycle commands,
profiles, groups, project registry, worktree management, web serving, MCP/skill
inspection, and ACP structured workers.  It can send a prompt to a running
agent; ACP also supports prompting, approvals, cancellation, event tailing, and
switching an ACP session to another agent while retaining the transcript.

Sources: [AoE overview](https://www.agent-of-empires.com/),
[CLI reference](https://github.com/agent-of-empires/agent-of-empires/blob/main/docs/cli/reference.md),
[quick start](https://github.com/agent-of-empires/agent-of-empires/blob/main/docs/quick-start.md),
[releases](https://github.com/agent-of-empires/agent-of-empires/releases).

**Strengths**

- Tool-neutral local control plane: this matches the OpenCode + Codex pairing.
- Scriptable JSON CLI and terminal/ACP control are a solid foundation for an
  external coordinator.
- Worktree creation/cleanup, session resume/fork, containers, web/mobile
  observation, multi-repo sessions and diff bases reduce outer-harness work.
- Active feature development is visible in the release history; the current
  release at research time is v1.13.2 (2026-07-29).

**Limits / risks**

- The official material presents a session manager, not a durable,
  role-aware review workflow engine.  `send` targets a session; it does not
  establish task ownership, a review protocol, or PR policy.
- AoE's `group` is not a TARS lane.  Treating it as one would lose the
  implementer/reviewer pairing and state semantics.
- CityHall, AoE's self-hostable shared control plane, is marked experimental;
  do not base a team-scale production decision on it without a pilot.

### 2. Orca / onorca: the closest native lane-like control plane

Orca makes each task a git worktree with its own branch, files, agent terminals,
and review/ship lifecycle.  The UI tracks worktrees, supports children and
descendant cleanup, and handles common worktree setup problems with shared
directories and `.worktreeinclude`.  Its CLI can create a worktree, select an
agent, send an initial prompt, apply setup policy, read/send/wait on terminals,
and use JSON output.  It also documents an embedded browser per worktree and
remote worktrees over SSH.

Most importantly for this question, its **experimental** orchestration layer
has a durable Run namespace/inbox; Tasks with dependencies and states; Dispatch
attempts; coordinator messages; worker completion/heartbeats; and decision
gates.  A worker can be launched in the current worktree, a new child worktree,
or a remote host.  This is substantially closer to native lane/task semantics
than AoE's documented session model.

Sources: [Orca worktrees](https://www.onorca.dev/docs/model/worktrees),
[Orca CLI reference](https://www.onorca.dev/docs/cli/reference),
[Orca orchestration](https://www.onorca.dev/docs/cli/orchestration),
[SSH worktrees](https://www.onorca.dev/docs/ssh).

**Strengths**

- The best match for “one visible work area per task/lane,” including agent
  status, diff review, browser/preview and issue-link ergonomics.
- Native task ownership, tracked completion, explicit delivery acknowledgements
  and task dependencies can eliminate much of a custom polling dispatcher.
- It supports heterogeneous agent choices (including Codex and OpenCode), plus
  local and remote workers.
- Its Git setup support directly addresses a practical TARS concern: ignored
  files, caches, and dependencies do not automatically appear in fresh
  worktrees.

**Limits / risks**

- Orchestration is opt-in experimental and has already retired earlier command
  forms.  That is a clear API-churn warning; use its current skill/API contract
  rather than scripting assumptions.
- The docs do not establish a predefined implementer/reviewer protocol,
  immutable-commit gate, or an issue/PR reopening policy.  Those likely remain
  domain workflow code (whether in TARS or Orca skills/automation).
- It is a GUI/runtime product rather than an open, detached CLI service; assess
  licensing, offline behavior, data handling, support, and automation
  survivability before adopting it as a team backbone.

### 3. AWS Labs CLI Agent Orchestrator (CAO): native coordination, missing the isolation layer

The AWS Labs project the engineer was likely referring to is
[**`awslabs/cli-agent-orchestrator`**](https://github.com/awslabs/cli-agent-orchestrator)
(CAO), not the unrelated AWS multi-agent application frameworks.  CAO runs a
local HTTP server (defaulting to localhost) and exposes the same coordination
model through CLI, MCP and REST APIs.  Agents receive terminal identities; a
supervisor can synchronously **handoff** to a worker, asynchronously **assign**
workers with a return callback, or send queued messages to an existing terminal.
It documents provider profiles for Kiro CLI, Claude Code, Codex, OpenCode and
other CLIs, terminal snapshots/restore, and role/allowed-tool restrictions
where provider support permits.  Its documented Python workflow runner supports
branching and concurrent fan-out, persists a durable journal, and can resume an
interrupted run.  Runs are explicitly user-invoked; the simpler YAML workflow
format does not yet execute its advertised parallel/pipeline/loop modes.  That
is relevant to TARS's crash/retry concern, but makes the script runner—not YAML
declarations—the meaningful comparison.

Sources: [CAO repository and documentation](https://github.com/awslabs/cli-agent-orchestrator),
[multi-agent orchestration section](https://github.com/awslabs/cli-agent-orchestrator/blob/main/README.md#multi-agent-orchestration),
[control planes](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/control-planes.md),
and [open provider-neutral worktree proposal #100](https://github.com/awslabs/cli-agent-orchestrator/issues/100).

**Why it matters:** CAO directly addresses the part AoE lacks: explicit
supervisor/worker routing, state, callbacks and heterogeneous roles.  Its REST
and MCP surfaces also make it a plausible substrate for a TARS policy layer
without pane scraping.

**Why it is not currently a standalone TARS/AoE replacement:** CAO's own open worktree issue
states that spawned `handoff`/`assign` workers presently share the same Git
branch and directory.  That creates exactly the concurrent overwrite/conflict
risk TARS worktrees avoid.  This does **not** rule CAO out: TARS/AoE can create
one isolated worktree per lane, then launch a CAO supervisor and its workers
inside that lane.  CAO can therefore be piloted now as the lane's coordination
layer while TARS/AoE remains the outer worktree allocator.  It needs native
worktrees only to replace that allocator too.  Its automatic worker cleanup is
also a trade-off against TARS's long-lived, inspectable implementer/reviewer
pair.

**Operational caution:** CAO's Codex documentation says that a non-interactive
tmux launch normally cannot answer approval prompts and describes a default
permission-bypass mode.  Any pilot must explicitly use the desired safe Codex
approval policy and demonstrate that a human can intervene; a more capable
control plane is not a reason to silently widen agent authority.

### 4. Groundcrew: backlog-driven local dispatch with real isolation

[Groundcrew](https://github.com/ClipboardHealth/groundcrew) is an MIT local
dispatcher aimed at the backlog-to-PR path.  It watches assigned Linear tasks
(with Jira and local-file task sources), routes labels to agent launch profiles,
creates one worktree/branch per task, and starts the real Claude, Codex, Cursor
or Pi CLI in a tmux/cmux/zellij terminal.  It defaults to Safehouse or Docker
Sandboxes and has worktree-preparation hooks, credentials guidance, and session
headroom/budget routing.

Source: [Groundcrew README and command/task-source reference](https://github.com/ClipboardHealth/groundcrew).

**Pros:** it is unusually aligned with the stated priority of a durable backlog:
assigned issues are its input, agent/model selection is explicit, and task
blockers are respected before dispatch.  Local terminals preserve human takeover
and each job is genuinely isolated.

**Cons:** the documented lifecycle is a dispatcher, not a two-role quality
protocol.  A reviewer can be launched as another task/profile, but correlation,
immutable-commit approval, cross-agent recovery, PR reopening and review policy
would still be TARS workflow code.  Its sandbox and task-tracker configuration
also add operational surface compared with AoE.

### 5. Vibe Kanban and dmux: competing human control planes

[Vibe Kanban](https://www.vibekanban.com/docs/getting-started/) is a local
task-board model: creating a workspace creates an isolated worktree and branch,
starts a configured agent, and can run setup/dev-server scripts.  A workspace
can contain multiple repositories, notes, sessions and a target branch; work
can be monitored and reviewed in the product.  It is a credible evaluation
candidate where the primary pain is *seeing and steering many tasks*, rather
than autonomous peer-to-peer coordination.

[dmux](https://github.com/standardagents/dmux) takes the opposite, terminal
first approach.  It is an MIT tmux application in which every task pane receives
a worktree and branch; it supports a broad set of coding CLIs (including Codex
and OpenCode), multi-select launches, durable/resumable panes, lifecycle hooks,
file/diff inspection and merge/PR actions.

**Pros:** both reduce the operator's worktree bookkeeping substantially.  Vibe
Kanban is the more legible task board; dmux is the lower-friction choice for a
terminal-native team that wants every worker visible at once.

**Cons:** neither official surface documents durable role handoffs, task-level
acknowledgements, reviewer gating, or a recovery-safe PR/reopen policy.  They
are better evaluated as replacements for an AoE-style *control surface*, not
for TARS's protocol.

Sources: [Vibe Kanban workspace lifecycle](https://www.vibekanban.com/docs/workspaces/creating-workspaces),
[Vibe Kanban execution monitoring](https://www.vibekanban.com/docs/core-features/monitoring-task-execution),
and [dmux README](https://github.com/standardagents/dmux).

### 6. Overstory: the nearest open-source attempt to build the full coding-team engine

[Overstory](https://github.com/jayminwest/overstory) deserves inclusion because
it attempts much more than workspace management: isolated worker worktrees,
SQLite-backed typed inter-agent mail, a persistent coordinator/supervisor role
hierarchy, a FIFO merge queue with tiered conflict resolution, mechanical and
AI-assisted watchdogs, session checkpoints and runtime-specific tool guards.
It can use a web UI for headless workers with tmux as an attach/steer escape
hatch.

**Pros:** this is the clearest external evidence that several TARS ideas are
not merely accidental reinvention: durable mail, workflow roles, watchdogs,
merge sequencing, recovery and enforcement need to exist somewhere above Git
worktrees.  It is the strongest candidate for a hands-on comparison of whether
TARS should be replaced by a complete engine rather than thinned around AoE.

**Cons:** its documented runtime matrix marks Claude Code and Sapling stable but
Codex and several others experimental; its architecture is substantially more
opinionated and operationally heavier than TARS.  It currently provides no
evidence that an OpenCode implementer plus Codex reviewer is a stable supported
pair.  Do not adopt based on feature density alone.

Source: [Overstory architecture, runtime matrix and operations documentation](https://github.com/jayminwest/overstory).

### Emerging radar: projects worth watching, not yet decision candidates

The following projects are sufficiently close to be useful signals, but the
available first-party evidence is too young, narrow, or untested to rank them
beside the candidates above.  They should not be mistaken for missing mature
replacements.

| Project | Why it is interesting | Why it is not yet a lead recommendation |
| --- | --- | --- |
| [Agetor](https://github.com/alamops/agetor) | Local Kanban for Claude/Codex with per-task worktrees, persisted SQLite runs, structured approval/question cards and multi-account harnesses. | A fast-moving single-project control plane; no documented multi-agent review protocol. |
| [MAP](https://github.com/pmarsceill/mapcli) | Daemon/CLI for spawning and observing many local Claude/Codex subprocesses with default worktree isolation and lifecycle events. | Its documented default is permission-bypassing autonomous launch; coordination/governance is thin. |
| [Codeg](https://github.com/xintaofei/codeg) | Cross-agent desktop workspace that can import/resume sessions and create worktrees for parallel work. | Primarily an integrated editing/collaboration surface, not an auditable task/review engine. |
| [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) | Broad programmable session API with persistent CLI sessions, councils and planner/coder/reviewer loops. | Very broad and opinionated; worktree and review-policy fit must be demonstrated, not inferred from its feature list. |
| [multi-agent-workflow-kit](https://github.com/laris-co/multi-agent-workflow-kit) | Reusable tmux + worktree recipe/toolkit. | Its own README labels it a proof of concept. |

This radar also establishes an important boundary for scope.  General agent
frameworks—such as Amazon Bedrock multi-agent patterns, LangGraph, AutoGen,
CrewAI or MetaGPT—may help write a custom supervisor, but they are not direct
local terminal/worktree harness substitutes.  They introduce a new application
runtime and still require session, terminal, Git isolation and delivery policy
to be built or integrated.  They are therefore adjacent implementation
building blocks, not the next shortlist for replacing AoE/TARS.

### 7. Conductor: a direct local-workspace alternative

Conductor models a workspace as a worktree, branch, agent chat and lifecycle;
its documentation covers setup/run/test steps, diff/PR/archive flow, and
gitignored `.context` files for workspace notes/handoffs.  Its Codex guide says
Conductor owns the worktree/branch lifecycle for each workspace.

Sources: [Git worktrees concept](https://www.conductor.build/docs/concepts/git-worktrees),
[run Codex with worktrees](https://www.conductor.build/docs/guides/git-worktrees/run-codex-with-git-worktrees).

**Pros:** a simpler, task-oriented desktop experience than a bespoke
AoE+TARS wrapper; worktree environment and PR ergonomics are first-class.

**Cons:** its docs do not show a multi-role workflow state machine; worktree
isolation is explicitly not security isolation, and agent permissions remain
host permissions.  It should be evaluated as a UI/control-plane replacement,
not as proof that durable review governance disappears.

### 8. Claude Code: native collaboration, but provider-bound and experimental

Claude Code documents four different parallel mechanisms: subagents, agent
view, agent teams, and isolated worktree sessions.  Agent Teams consist of a
lead, independent teammates, a shared task list, and direct mailbox messaging.
Worktree isolation can be applied to subagents.  This is strong native
coordination for a team of Claude sessions.

Sources: [parallel agents](https://code.claude.com/docs/en/agents),
[agent teams](https://code.claude.com/docs/en/agent-teams),
[worktrees](https://code.claude.com/docs/en/worktrees).

**Pros:** real task/message coordination rather than only terminal management;
worktrees are configurable; especially attractive for research, competing
debugging hypotheses, or a partitioned multi-module implementation.

**Cons:** Agent Teams are experimental, disabled by default, interactive-only,
and the official docs warn that they add coordination/token overhead and are a
poor fit for sequential or same-file work.  It also does not natively model the
heterogeneous OpenCode-implements/Codex-reviews division central to TARS.

### 9. Codex app: use the existing native capability before wrapping it

The Codex app is explicitly designed to run several agents in separate threads
organized by project, with built-in worktrees so their edits do not collide.
It supplies diff review, skills and automations.  OpenAI says it will continue
refining multi-agent workflows based on feedback, which is useful evidence of
direction but also means one should not infer a fully specified orchestrator.

Sources: [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/),
[Codex product page](https://openai.com/codex/).

**Pros:** already available to this team; native worktree isolation and Codex
task management may make a separate reviewer-session launcher unnecessary for
Codex-only lanes.

**Cons:** official product information does not document cross-agent durable
handoffs, task DAGs, or an OpenCode↔Codex review state machine.  It is therefore
complementary to a heterogeneous harness rather than presently a drop-in
replacement.

### 10. GitButler: a deliberately different isolation trade-off

GitButler supports parallel agents working on virtual branches in one working
directory, with agent setup and hunk-level attribution.  That can avoid
duplicated dependency directories and duplicate local servers.

Sources: [AI agents overview](https://docs.gitbutler.com/ai-agents/overview),
[parallel agents](https://docs.gitbutler.com/ai-agents/parallel-agents).

**Pros:** potentially lower setup cost and better VCS ergonomics where many
small, non-overlapping changes are made in one repo.

**Cons:** this is shared-filesystem work, not a worktree boundary.  It is not a
fit for TARS's need for isolated concurrent agents, independent runtime state,
or deterministic lane-level diffs.  Treat it as a separate experiment, not an
AoE/Orca substitute.

## Delivery workflow capabilities added to the comparison

### Stacked PRs: a delivery layer, not a replacement for worktrees

A worktree gives an agent an isolated *place to make a change*.  A stack gives
humans a dependency-ordered *way to review and merge that change*.  They should
be composed, not confused: TARS/Orca/AoE may allocate the implementation
worktree, while a stack tool turns a committed result into review units.

[Graphite](https://graphite.com/docs/cli-overview) is the clearest mature
candidate for this delivery layer.  Its `gt split` command can split existing
history by commit, file, or hunk; `gt submit` creates or updates distinct GitHub
PRs for a branch stack; `gt modify`/`gt restack` propagate a changed lower layer
to dependent branches.  It can assign reviewers and create draft PRs during
submission.  Its docs describe the intended outcome directly: each stack layer
can be tested, reviewed and merged independently.

Sources: [Graphite command reference](https://graphite.com/docs/command-reference),
[creating/submitting a stack](https://graphite.com/docs/create-submit-prs),
[review-feedback and restacking workflow](https://graphite.com/docs/cli-quick-start),
and [collaboration/frozen branches](https://graphite.com/docs/collaborate-on-a-stack).

**What Graphite does well**

- It is an explicit, scriptable Git/GitHub model for parent/child branches and
  PRs, rather than an agent being asked to improvise rebases and PR bases.
- It handles the hard mechanical consequence of editing a lower reviewed layer:
  restacking dependent branches and exposing conflicts.
- It supports a human external reviewer for each generated PR, including draft
  creation and reviewer assignment.  A “frozen” branch can protect a remote
  stack layer against accidental local modification.

**Limits that matter for TARS**

- `gt split` can slice history structurally, but it cannot prove that a file or
  hunk boundary is a meaningful architecture/review boundary.  A planning or
  review authority must approve the proposed stack before publication.
- Restacking rewrites dependent commit ancestry.  The workflow needs a durable
  map from TARS iteration, original commit(s), stack branch, PR URL and current
  head SHA.  Otherwise a previous approval can be incorrectly treated as an
  approval of rewritten code.
- Graphite is a Git/GitHub delivery tool, not an agent coordinator: it does not
  provide role handoffs, worktree recovery, or governed interpretation of PR
  comments.  It is a strong *complement* to AoE/Orca/TARS, not a substitute.

[CodeRabbit Change Stack](https://docs.coderabbit.ai/pull-request-reviews/change-stack)
is another relevant review surface: it reorganizes a large PR into a guided,
logical walkthrough rather than a flat alphabetical file list.  This can reduce
reviewer cognitive load without rewriting branches.  CodeRabbit's
[Autofix](https://docs.coderabbit.ai/finishing-touches/autofix) is beta and can
create a stacked PR from eligible unresolved CodeRabbit threads; its
[changelog](https://docs.coderabbit.ai/changelog) also documents stacked PR
delivery for CI fixes.  These are valuable aids, but they are CodeRabbit-run
changes in a sandbox—not evidence of a TARS-compatible, human-approved
multi-role lane.  Treat both as opt-in review assistance and retain an explicit
human approval before anything joins a TARS stack.

[GitButler](https://docs.gitbutler.com/ai-agents/parallel-agents) has useful
parallel-agent and virtual-branch ergonomics.  Its
[stacked-branches model](https://docs.gitbutler.com/features/branch-management/stacked-branches)
creates dependent branches and PRs targeting their parent, supports commit
movement/squashing/amendment, and has operation-log restoration.  Its CLI is a
real local scripting alternative worth a short comparison with Graphite.
However, GitButler's own parallel-agent documentation says its shared workspace
is not runtime isolation: use worktrees where isolated runtimes or checkout
state are needed.  It is therefore complementary to TARS lanes, rather than a
replacement for them.

Sapling's [Git stack support](https://sapling-scm.com/docs/git/sapling-stack/)
can submit a PR per commit (`sl pr submit --stack`) and update linked PRs, but
its documentation notes that GitHub's normal presentation can show overlapping
commits and recommends ReviewStack for the intended view.  It is worth watching
where a team is already standardized on Sapling, but is not the recommended
TARS pilot: it introduces a separate source-control workflow without solving
feedback governance or heterogeneous-agent coordination.  Neither currently
displaces Graphite as the most direct post-hoc-splitting spike.

GitHub itself supplies a **merge queue**, not a stack-authoring model.  It can
validate queued PR changes with the current base and preceding queued PRs, and
merge only after required checks pass; CI must handle the separate
`merge_group` event.  That is useful for independent PRs, but it does not
create dependency branches or make a huge PR easier to review.  More
importantly, Graphite documents that GitHub Merge Queue does not understand
stacks and can merge their PRs out of order.  A TARS stacked-PR pilot must
therefore choose and test a stack-aware merge path (for example Graphite's
bottom-up stack merge), rather than casually combining GitHub Merge Queue with
dependent PRs.

Sources: [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
and [Graphite's merge queue guidance](https://graphite.com/docs/github-configuration-guidelines).

### Planning: make the plan a human-owned contract

The requested “Matt Pocock-style grilling” should be added as a **planning
mode**, not hidden inside a more verbose implementer prompt.  A recommended
artifact is a versioned `plan contract` with: problem/outcome; explicit
non-goals; assumptions and open questions; interfaces and invariants; edge and
failure cases; migration/rollback; verification evidence; proposed reviewable
increments; dependencies; and an author decision for every ambiguity that
materially changes scope.

The agent's job is to challenge and draft this contract, then propose a DAG of
increments.  The human author owns approval and may edit the plan and its
boundaries.  Only a plan-contract SHA plus an author-approved iteration manifest
may enter execution.  A later plan change should create a new revision and
explicitly mark unstarted iterations superseded; it must never quietly reshape
an in-flight lane.

Orca's experimental Run/Task/Dispatch and decision-gate concepts are promising
control-plane primitives for a pause/decision.  They do **not**, from the
documented surface, supply the above question taxonomy, author-owned plan
version, or a semantics-aware iteration boundary.  AoE, dmux, Vibe Kanban and
CAO similarly can host a planning agent or pause a session, but none removes
the need for this workflow policy.  This is an area where TARS is intentionally
not reinventing a worktree feature: it is encoding a team decision right above
the harness layer.

### Feedback intake: GitHub and CodeRabbit are event sources, not controllers

GitHub provides the necessary primitives.  A GitHub App can subscribe to
`pull_request_review`, `issue_comment`, `pull_request_review_comment`, and
`pull_request_review_thread` activity; the last reports a thread being marked
resolved.  The REST API can list reviews, and GitHub's GraphQL model exposes
review threads and their comments.  This supports low-latency webhook intake
with a polling/reconciliation fallback, including a cursor/watermark for
restart recovery.

Sources: [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[REST pull-request reviews](https://docs.github.com/en/rest/pulls/reviews), and
[GraphQL pull-request review threads](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread).

Where GitHub Actions is the chosen transport instead of a GitHub App webhook,
the supported triggers include `issue_comment`, `pull_request_review`, and
`pull_request_review_comment`.  Fork PRs have important token/secrets
restrictions, so a feedback worker must not execute untrusted fork code as a
side effect of receiving a comment.

Source: [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

The correct architecture is a small **feedback adapter** at the GitHub/PR
boundary, not UI polling in AoE or Orca:

```text
GitHub human review / CodeRabbit review / CI
                 │ webhooks + reconciliation poll
                 ▼
deduplicated feedback inbox (PR, delivery/comment/thread/review IDs, head SHA)
                 │ classify: informational | needs-author decision | actionable
                 ▼
human approval to open a follow-up iteration
                 ▼
new/reused isolated worktree → implementer → immutable commit → reviewer handoff
                 ▼
external human review → record disposition and reply/resolve only with authority
```

The durable inbox must retain original payload identity, author, source,
timestamp, thread state, the PR head SHA it applied to, classification,
disposition and link to the follow-up iteration.  Delivery IDs make webhook
processing idempotent; periodic reconciliation catches missed deliveries.
The system should group a submitted review's inline comments into one candidate
feedback batch, while preserving individual thread identities.  It must
distinguish a fresh comment on a newer head from an already-addressed stale
comment, and it must never auto-resolve external threads merely because an
agent says a change is complete.

This design works whether the worktree/session substrate is AoE, Orca or
another tool.  Orca may supply the visible worktree and a decision gate; AoE
may supply the session; neither replaces GitHub's event API nor TARS's
authorization, correlation and approval rules.

### Required acceptance tests for a real-issue pilot

| Scenario | Pass condition | Native tool contribution | Policy/integration that remains TARS-owned |
| --- | --- | --- | --- |
| Human-shaped plan | The agent produces a challenge log and proposed increments; author edits/approves a versioned manifest before any build dispatch. | Orca decision gate / AoE session pause can present the choice. | Question taxonomy, plan schema/versioning, author authority and dispatch guard. |
| Split a large lane result | A test PR becomes 2–5 named stack layers with correct bases, each diff independently reviewable; original branch/PR is preserved until a human accepts replacement. | Graphite split/restack/submit; CodeRabbit Change Stack can aid review without rewriting. | Logical slicing criteria, stack proposal approval, commit/PR provenance and rollback. |
| External human review | A non-author review requesting changes yields one visible candidate batch; no worker starts until an operator approves. | GitHub review API/webhooks and PR UI. | Deduplication, classification, authorization, lane correlation and handoff creation. |
| CodeRabbit finding | A new unresolved CodeRabbit thread is correlated to the exact PR head; an approved TARS iteration addresses it and retains the thread link. | GitHub event surfaces; optional CodeRabbit Autofix/Change Stack. | Treat CodeRabbit as feedback—not authority; reviewer approval, tests, thread disposition. |
| Restart/replay | Replaying a webhook/restarting the coordinator produces no duplicate worktree, dispatch or PR update; operator sees why each candidate is pending/resolved. | GitHub delivery/reconciliation primitives; Orca/AoE durable session state where available. | Inbox journal, idempotency keys, recovery UI and explicit resume action. |
| Stacked merge | Each approved layer is independently mergeable and required checks pass against its correct base; the selected stack-aware merge path preserves bottom-up dependency order. | Graphite dependency maintenance and stack merge. | Which layers can merge, approval freshness after restack, conflict escalation and release policy. |

### Practical recommendation for tomorrow

1. **Add planning and iteration-shaping before adding more autonomy.**  Build a
   human-approved plan contract/iteration manifest on the current TARS lane,
   including the interrogative planning mode.  This is harness-independent and
   directly satisfies the author-control requirement.
2. **Run a Graphite spike on one already-large generated PR.**  First create a
   read-only proposed dependency map; then use a disposable copy to test
   `gt split` and `gt submit --stack --draft`.  Measure whether 2–5 layers are
   genuinely reviewable by an external reviewer, how restacks affect approvals,
   and how readily the original can be restored.  Do not make destructive
   history changes to the only copy of the current PR.
3. **Add a GitHub feedback inbox in observe-only mode.**  Receive/webhook or
   reconcile comments, reviews and review threads; show the exact candidate
   follow-up and the relevant head SHA; require a human “open iteration” action.
   Only after replay/recovery tests should it dispatch the existing TARS
   handoff-and-approval loop.
4. **Pilot Orca separately on the full scenario.**  Confirm that its
   experimental multi-role orchestration can launch and recover an
   implementer/reviewer flow, present the author decision points, and expose
   the feedback iteration.  Do not assume worktree-first implies this protocol
   exists natively; score it against the table above.

## What TARS currently builds

Repository evidence shows the following division:

| TARS capability | Current implementation evidence | AoE overlap? | Assessment |
| --- | --- | --- | --- |
| Create/remove worktree and implementation session | `startLane` calls AoE `add --worktree --new-branch`; close removes AoE sessions/worktree/branch | High | Keep a thin adapter; avoid duplicating names/lifecycle beyond policy validation. |
| Add/discover/restart persistent agent sessions | `AoeClient`, `discoverPair`, readiness polling, `send` | High | Prefer AoE's session model/JSON/ACP lifecycle. Keep only checks needed to uphold lane invariants. |
| Lane registry and state | SQLite record per worktree with roles, phase, rounds and idempotent journal | Low | TARS-specific; retain unless switching to Orca Run/Task/Dispatch after parity testing. |
| Durable cross-agent handoff | `.agent-handoff/` with IDs, workflow IDs, rounds, commits, outcomes | Low | Retain. A terminal message is not an auditable, replay-safe handoff. |
| Plan approval and serial reviewable iterations | plan verdict → compact → build; per-iteration immutable commit review | Low | Retain as a quality/delivery policy. |
| Human-shaped plan contract and iteration manifest | Not yet represented as an author-versioned artifact with a dispatch guard | Low | Add to TARS. A decision gate can host the pause, but human ownership of plan scope/boundaries is policy. |
| Routing & retry protection | exact registered role/session, correlation fields, round caps, reopen marker | Low | Retain. This protects against stale or cross-lane prompts. |
| PR/feedback lifecycle | only final approval creates PR; explicit reopen updates existing PR | Low | Retain; it is team process policy, not generic worktree management. |
| External review feedback inbox | Not yet automated for GitHub human/CodeRabbit comments | Low | Add a GitHub webhook + reconciliation adapter and an approval-gated follow-up handoff. Outer harnesses do not replace it. |
| Large-PR delivery decomposition | Not yet represented as stack branches/PRs | Low | Integrate a stack tool (Graphite first; compare GitButler) after a human accepts a proposed logical boundary map. |
| Branch/worktree naming preflight | bounded OpenCode naming/classification plus deterministic fallback | Medium | Consider replacing with issue-provider / Orca native names, but preserve deterministic fallback and validation. |
| Agent skills/install/bootstrap | global/per-worktree TARS skills and prompts | Low | Retain as portable conventions; AoE/Orca may distribute or invoke them more conveniently. |

Evidence: [TARS README](../README.md),
[review-loop reference](../automations/review-loop/README.md),
[workflow protocol](../protocols/README.md),
[AoE adapter](../automations/review-loop/lib/aoe.mjs), and
[lane lifecycle](../automations/review-loop/lib/lane.mjs).

## AoE capabilities TARS should test before building more

This is an opportunity list, not a claim that all should be adopted.

1. **Use AoE as the authoritative lifecycle/control plane.**  Keep TARS's
   `AoeClient` narrow, but prefer AoE `list`/`ps --json`, worktree cleanup,
   profiles, project registry, groups and session archive/restore rather than
   creating parallel bookkeeping or cleanup behavior.
2. **Evaluate ACP for structured delivery and observation.**  The existing
   adapter sends terminal text and polls pane capture for readiness.  Test
   `aoe acp prompt`, status/tail, approval and cancellation for more reliable
   delivery/observability.  Do not remove file handoffs until restart and
   missed-delivery behavior is proven.
3. **Use AoE session metadata for operator visibility.**  A session group,
   title, color/favorite/snooze, base ref, and archive status can make a lane
   legible without TARS recreating an operator UI.  Store the policy mapping
   (lane → role sessions) in TARS, not only in labels.
4. **Adopt existing environment isolation where needed.**  Pilot AoE Docker
   sandboxes for untrusted/risky work and its multi-repo session support for
   cross-repository changes.  This is orthogonal to handoff correctness.
5. **Use fork/resume deliberately.**  AoE can preserve/fork conversations.
   That may improve plan-to-build continuity or create bounded alternatives,
   but the reviewer must still see a committed artifact and stable handoff.

## What no outer harness removes

Even the best control plane does not eliminate these decisions:

- **Work partitioning and ownership:** worktrees prevent file clobbering, not
  semantic conflicts or conflicting architectural decisions.
- **Protocol and source of truth:** an implementer/reviewer exchange needs
  correlation, immutable revision identity, acknowledgement and recovery.
- **Quality gate policy:** who reviews, what counts as approval, when to run
  tests, and whether reviews occur after each iteration are organizational
  choices.
- **Delivery policy:** PR creation, branch protection, external review
  feedback, merge, rollback and escalation are repository/team-specific.
- **Environment policy:** secrets, database/port isolation, migrations, shared
  services and destructive permissions must be handled above `git worktree`.
- **Cost and concurrency control:** parallelism is beneficial only for
  sufficiently independent tasks; it multiplies token/runtime cost and can
  increase integration work.

## Provisional recommendation

1. **Do not replace AoE immediately.**  First simplify TARS/AoE boundaries and
   pilot AoE ACP plus its existing lifecycle features.
2. **Run a time-boxed Orca proof of concept.**  Recreate the two concrete TARS
   scenarios from #2 and #1: a human-gated approved iteration with a draft PR,
   and recovery after an interrupted worker.  Include planning,
   implementer/reviewer handoff, one change-request round, approval, PR
   feedback reopen and cleanup.  Use Orca's experimental Run/Task/Dispatch
   rather than only its worktree UI.
3. **Compare the result against explicit acceptance criteria**, not novelty:

   - no cross-lane message or state contamination;
   - an immutable commit is reviewable and linked to its approval;
   - crash/restart does not duplicate dispatch or lose a handoff;
   - an operator can see owner, status, blockage and next action quickly;
   - worktree setup, secrets, ports and cleanup are reliable;
   - PR/reopen behavior follows the current policy;
   - scripts can automate the critical path without fragile UI scraping;
   - total operator effort and failure recovery are measurably lower than TARS.
   - an optional approved-increment checkpoint can create a reviewable draft
     PR and pause the existing lane until a human explicitly continues it;
   - after coordinator or agent interruption, the system can present
     evidence-backed recovery choices without duplicate dispatch, and cannot
     resume solely because a GitHub issue exists.

4. **Add two deliberately different pilots, rather than an undifferentiated tool tour.**
   - Treat **Groundcrew** as an optional, deliberately different experiment:
     test issue pickup, routing, sandboxing and local takeover only if TARS
     later wants assigned issues to trigger unattended work.  It does not
     improve the two currently parked issues merely because they live in
     GitHub.
   - Pilot **CAO as a composable coordination layer now.**  Let TARS/AoE
     allocate one worktree per lane, then run CAO's supervisor/worker protocol
     within that lane.  Test handoff/assignment, workflow-journal resume, role
     restrictions and human approval configuration.  Do **not** use CAO's
     parallel workers for same-repository implementation without that outer
     worktree boundary.

5. **Use Claude Teams and Codex app selectively.**  They are excellent agents
   to delegate exploration or independent coding to, but neither is currently
   evidenced as the cross-provider, durable review coordinator TARS uses.

6. **Treat dmux/Vibe Kanban as operator-experience substitutions and Overstory
   as an architectural replacement test.**  The former pair may make local
   worktree operation simpler without changing policy; Overstory is the only
   added candidate that claims most of the policy/merge/recovery territory, so
   it merits a more skeptical, end-to-end evaluation rather than piecemeal
   adoption.
7. **Treat delivery decomposition and external feedback as first-class TARS
   boundaries.**  Add the human-owned plan contract and approved iteration
   manifest before dispatch; evaluate Graphite (then GitButler) as a separate
   stack-delivery layer; and start GitHub/CodeRabbit intake in observe-only
   mode.  Do not mistake CodeRabbit Change Stack for real Git branches, nor
   GitHub Merge Queue for a compatible stacked-PR merger.

## Confirmed operating decisions and remaining deployment questions

The following decisions now anchor the evaluation:

1. **Personal local command centre.**  A team-wide shared service is not the
   immediate goal.  Local-first operation and a low-friction human control
   surface therefore outweigh central administration features.
2. **Harness-agnostic roles.**  More providers will join over time, and the
   same harness may act as both implementer and reviewer.  The required
   invariant is independent role sessions and an immutable artifact for review,
   not a fixed OpenCode-versus-Codex pairing.
3. **Independent review is non-negotiable.**  Every lane retains a review gate
   as the second pair of eyes; a "cheap" single-agent route is out of scope.
4. **Decision metric: operator attention.**  Prefer the option that closes
   lanes with high-quality output while requiring the least unnecessary
   monitoring, context reconstruction, intervention, and recovery work.
5. **Runtime isolation: staged.**  Immediate target: every worktree can run
   its unit and integration tests independently.  Per-lane databases,
   credentials, cloud accounts, and full service isolation are likely later
   needs, but are not immediate selection gates.

The deployment posture is now also clear:

1. **Local execution now.**  Personally controlled SSH/VM worktrees are a
   future nice-to-have, not part of the immediate solution.  Third-party hosted
   sandboxes are out of current scope.
2. **No outer-harness repository-data egress.**  The control plane must not
   send repository metadata, file names, diffs, terminal output, prompts, or
   other repository-derived data to its vendor.  Non-repository usage telemetry
   such as selected model or mode is acceptable.  This constraint concerns the
   outer harness, separately from the chosen model provider receiving the
   context needed to perform an agent task.
3. **OSS-first.**  Prefer an inspectable, forkable coordinator that can be
   retained if its vendor disappears.  Proprietary tools remain useful
   comparison targets, but may enter the solution only after their local-data
   behavior is verified and their unique operational benefit is compelling.
4. **Pragmatic connectivity.**  Since current harnesses depend on network
   model access, offline lane control is a convenience rather than a selection
   gate.  Choose straightforward local behavior; do not add offline complexity
   prematurely.
5. **Controlled aggression.**  Future remote execution may automatically
   provision/tear down worktrees, forward ports, and launch agents.  Automation
   should be assertive against the backlog, while durable review gates, explicit
   human decisions, and recovery safeguards constrain destructive or ambiguous
   actions.

This strengthens the layered recommendation: favor an OSS local substrate and
retain a small portable policy/protocol layer; treat proprietary local tools
such as Orca or Conductor as conditional pilots rather than assumed foundations;
and replace duplicated pieces only after a scenario test proves an alternative's
reliability and data behavior.

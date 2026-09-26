# Plan: on-demand investigation of active TARS lanes

Status: intermediate, provisional implementation plan for [issue #18](https://github.com/satwikhebbar/tars/issues/18), based on [requirements](../requirements.md). Complete the [navigation evidence spike](spike-navigation-evidence.md) and the post-spike design work below before treating this as an implementation-ready plan. This plan changes the issue's original artifact-store proposal: TARS reads harness-owned evidence while a lane is active and keeps no investigation evidence or findings.

## Outcome

An operator can explicitly enable native evidence when launching a Codex/OpenCode lane, then run a navigation-efficiency investigation while both role sessions are idle. TARS examines both roles across the lane to date, groups activity by handoff and iteration, and prints a lane-wide narrative of repeated reads/searches and exploration breadth, with block-level detail only where a notable pattern was found. It includes a repository improvement only where supported. If the planned analysis exceeds its budget, TARS stops and lets the operator raise the budget for whole-lane coverage or select fewer logical blocks. The operator may export the result as Markdown. TARS leaves the role sessions and worktree unchanged and discards its processing data when the command finishes.

The initial question is `navigation-efficiency`. The design supports later built-in or operator-configured questions, including risky-workflow review, without implementing those questions or live alerts in this issue.

## Post-spike plan completion

Review the spike's decision record, then update this plan and the requirements wherever native evidence changes an assumption. Before implementation, produce these high-level designs and choices:

1. **Transient evidence index:** Define its entities and relationships (role session or segment, native event, logical block, observed file content, search, compaction boundary, handoff commit, evidence pointer, and coverage gap). Specify ordering, stable provenance back to native evidence, direct versus inferred observations, known versus unknown read extent, and how the index is built and discarded without becoming a persistent store. Derive the shape and classification boundaries from the measured Codex/OpenCode traces rather than treating the event list in step 3 below as final.
2. **Harness adapters and attribution:** Define the minimum data each native source must provide, how role/session identity and replacement sessions resolve, how raw tool forms map to index observations, and what becomes an explicit coverage gap. Record supported CLI versions and any source-specific limits.
3. **Analyst input and cost:** Choose between a deterministic projection, bounded native-context selection, analyst-directed retrieval, or complete relevant context based on the spike. Define how the analyst sees every in-scope logical block and its handoff commit, how it can consult repository history, and how input size and cost are estimated. Set the default analysis budget and the CLI flow for raising it or selecting fewer blocks before an over-budget call.
4. **Question and report contracts:** Define the reusable question interface and the navigation question's findings schema. Finalize the CLI/Markdown report structure from the spike's sample reports, including lane-wide narrative, notable block details, literal queries, native evidence citations, hypotheses, contrary evidence, unknowns, and partial-coverage labels. Specify how citations and report content are validated.
5. **Operational and acceptance details:** Settle capture paths and launch/recovery behavior, read-only analyst execution for each supported author harness, temporary-file cleanup, and the concrete verification cases. Reconcile issue #18's acceptance criteria with the requirements before implementation review.

Steps 1–5 under **Sequence** are the provisional implementation order. Revise their specifics after these post-spike decisions; do not treat the example index fields or analyst projection below as fixed before the evidence review.

## Sequence

### 1. Prove the native-source paths before designing adapters

- Run an opt-in, disposable Codex CLI session with `CODEX_ROLLOUT_TRACE_ROOT` set outside the repository. Verify bundle creation and `codex debug trace-reduce <bundle> --output <temporary-path>`. The installed Codex CLI accepts the reducer command, although its parent help does not list it. Record the minimum working Codex version and sanitized bundle fixture.
- Verify an AoE Codex role can receive a unique environment value at launch through `--cmd-override` or a controlled wrapper. Extend TARS's AoE launch abstraction only after this probe establishes the safe quoting, lifecycle, and recovery behavior. AoE currently accepts extra CLI args but offers no dedicated per-session environment flag.
- Verify OpenCode's export shape at a pinned supported version, including tool inputs, outcomes, timing, token information, and stable session/message/part identifiers. Confirm which fields survive `--sanitize`; use raw native output transiently if sanitization removes fields needed for the analyst or literal-query report.
- Verify attribution from each active AoE role to exactly one native OpenCode session using AoE session creation time, worktree path, harness, and native session metadata. Cover same-harness author/reviewer lanes and recovery. Refuse ambiguous matches.

**Gate:** Do not start the shared analysis layer until both harnesses can provide attributable evidence and their gaps are documented. A missing field is reported as coverage, not invented by the adapter.

### 2. Add launch opt-in and active-lane validation

- Add an explicit investigation opt-in to `tars lane start`; default remains off. Validate that both selected harnesses are Codex or OpenCode before creating the lane. Do not enable investigation for `lane register`, `tars start` on existing sessions, or standalone sessions in the first cut.
- Give each Codex role a unique native trace root under Codex-owned local state, outside the worktree. Persist only the chosen mode and the orchestration information needed while the lane is active. Derive trace locations from the active lane/session identity where practical; do not create a TARS evidence registry.
- Ensure `lane recover` and `lane resume --create-sessions` preserve the opt-in for replacement Codex sessions without conflating their trace bundles. A replacement session is a distinct evidence segment with a visible gap if earlier evidence is unavailable.
- Add an on-demand investigation command that requires a registered, unclosed lane and checks both AoE roles are idle. Capture an as-of point before reading native evidence and recheck role state after the snapshot; if work resumed during collection, mark or reject the inconsistent snapshot. If one role has no usable source, continue with an explicit coverage gap; if identity is ambiguous, do not attribute its events.

### 3. Build a transient, question-neutral evidence index

- Adapt Codex's reduced trace and OpenCode's native session data into a small in-memory event shape: role, native evidence ID, order/time, raw tool category, direct target, separately inferred command paths, visible-output path evidence, read extent where known, outcome, duration, compaction marker where known, and available token metrics. Preserve adapter and harness versions and mark unsupported or ambiguous event classes. Finalize navigation classification only after the spike tests real shell-command variants.
- Read TARS handoffs and lane state to construct logical blocks: planning and verdicts, each implementation/review iteration, and reopened PR-feedback cycles. Include handoff commit SHAs in analyst context. Place events from both roles in those blocks; mark events whose boundary cannot be established. Compare repeated reads, searches, and timing both within and across blocks.
- Use bounded streaming or a permission-restricted temporary file for large native exports. Never write raw data to the worktree. Direct Codex reduction output to a temporary path rather than modifying its native bundle. Remove temporary files on success, error, or interruption.
- Produce deterministic counts, ordered trails, evidence pointers, and coverage diagnostics before asking an LLM for interpretation. Count repeats within each role, distinguish full from partial reads, and treat a confirmed compaction as resetting repetition for both reads and searches. Preserve an author's full reread after an edit or reviewer feedback as a candidate for analyst judgment, with verification as a possible explanation. For a reviewer across review rounds, compare handoff commit SHAs and file changes: rereading a changed file is expected; flag an unchanged file's repeated full read only if no compaction intervened. Let the analyst consult Git history if useful, without requiring historical reconstruction for every event. Count a file toward exploration breadth only when some of its content was visibly returned, not merely scanned or named in a filename-only result; judge the resulting breadth against task context rather than a fixed threshold. Let the analyst judge whether differently worded searches pursued the same answer. Do not count ambiguous shell commands as confirmed reads or attribute a turn's token use to a specific file read without evidence.

### 4. Add the navigation question and separate analyst

- Define a question interface around an evidence-index projection, instructions, output schema, and validator. Implement only `navigation-efficiency`. Later questions reuse source adapters, logical blocks, provenance, and analyst invocation.
- Use the analyst input strategy selected by the evidence spike, including native prompt/tool-output context if needed to understand the agent's objective. Make an overview of every block and estimate the analyst input against a documented budget. If full-lane analysis exceeds that budget, do not invoke the analyst or silently choose noteworthy blocks. Show the operator the handoff/iteration block inventory and estimated cost. Offer an explicit budget increase for whole-lane coverage or selection of a smaller logical scope. Continue only with the operator's choice and label a narrowed report accordingly; never present it as a complete-lane judgment.
- Invoke the lane's author harness as a separate analyst session, following TARS's current preflight pattern and resolved author model. Give it the bounded summary plus read-only access to the worktree. Deny edits and unrestricted shell actions; verify this for Codex and OpenCode. Keep the analyst outside both lane role sessions and exclude its own activity from lane attribution.
- Require structured findings with cited native event IDs, an explanation of observed symptoms and any hypothesis of avoidable work, supporting and contradicting evidence, uncertainty, and unknowns. A repository change is optional and must have a rationale grounded in the current repo structure. Do not draft replacement prose in the first cut. Validate citations against the evidence index. Reject unsupported claims or render them explicitly as unverified analyst opinion.

### 5. Present the result and document limits

- Print a concise CLI report with a lane-wide narrative of repeated reads/searches and exploration breadth, role comparisons where informative, evidence-linked diagnoses and hypotheses, and supported optional recommendations. Include block-level detail for notable patterns and explain coverage gaps without an uneventful-block walkthrough. For notable search patterns, include both a description of search intent and the literal query. If no notable issue is supported, give a short no-issue narrative with coverage and basic counts. Offer an explicit Markdown export path; write no report by default.
- Validate and project the analyst's output so the report contains paths, metadata, and relevant literal search queries but no other raw prompts, source contents, or tool output. Do not redact queries in local CLI output or requested Markdown export. State the analyst harness/model, input scope, and that its call incurs model cost.
- Document opt-in capture, native data locations and retention ownership, idle-only execution, incomplete evidence, direct targets versus inferred command paths, and the fact that the findings are hypotheses rather than proof of counterfactual necessity.
- Update issue #18's final scope before implementation review: remove TARS-owned artifact storage, TARS raw-data retention, and post-close reporting from its acceptance criteria.

## Verification and acceptance

1. Existing lanes launch and operate exactly as before with investigation off. Unsupported harnesses fail before lane creation when opt-in is requested.
2. An opted-in Codex role produces an attributable native bundle; an OpenCode role resolves to one native session or reports ambiguity. Both-role and same-harness pairs are covered.
3. `investigate` refuses a closed lane or busy role. It can report partial coverage when one source is missing without assigning that source's actions to the other role.
4. Sanitized fixtures produce a repeatable block timeline and direct-target/inferred-path split. Importers reject unknown source shapes with useful coverage diagnostics. A long fixture demonstrates that TARS stops before an over-budget analyst call, offers logical blocks, and labels a narrowed report's scope.
5. The analyst runs separately with verified read-only repo access. Its citations resolve to indexed events, and the main role sessions receive no investigation prompt or output.
6. Default invocation creates no TARS-owned raw artifact, report, or worktree file. Optional Markdown export contains metadata, relevant literal search queries, and the analyst's narrative, with other raw prompts, source contents, and tool output excluded. Temporary files are removed on failures as well as success.

The first cut exports Markdown only; a machine-readable format can be added later without changing evidence collection.

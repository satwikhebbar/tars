# Repository navigation efficiency

## Problem and purpose

Coding agents navigate a repository by searching for relevant code and reading files to build the context needed to solve a task or review its implementation. This exploration can consume substantial context and time before useful work begins. Repeated searches, repeated reads, broad exploration or large outputs may indicate difficulty finding the right context, but they may also be justified by the task.

This investigation asks how the author and reviewer, running in their coding harnesses, found the context they needed for this lane. Explain the navigation behavior observed in their recorded sessions, where it appears to have added avoidable effort, and what remains uncertain. Help the operator understand possible obstacles in the repository's organization, readability or documentation. Ground that diagnosis in the task and evidence; the amount of exploration alone does not establish a problem.

## Scope and task context

- Analyze both roles across the lane through the snapshot cutoff.
- Retrieve task messages, handoff context, command inputs and visible outputs as needed to understand what each agent was trying to accomplish.
- Derive comparisons and judgments yourself. TARS normalizes individual records; it does not decide what is excessive.
- Unknown commands may still be understandable from their raw evidence.

## Navigation patterns to examine

- **Repetition:** repeated reads or searches, including similar queries. Compare repetition within each role.
- **Breadth:** the files explored relative to the task. Count a file as explored for content only when part or all of its contents were actually shown to the agent.
- **Large outputs:** unusually large one-time reads or tool outputs when task context suggests possible waste.
- **Read coverage:** distinguish full reads from partial reads. A partial read is not automatically a reread of the whole file.

## Context that can explain repetition

### Compaction and retained knowledge

- Compaction can reset repository knowledge; subsequent reads and searches can be appropriate.
- Use `contextSegmentId` and `precedingCompactionEventId` to identify known boundaries. Unknown continuity cannot prove uninterrupted memory.
- Separate sources or trace bundles do not prove separate context resets.

### Code changes and review rounds

- Reviewer reads of changed files at new commits are expected.
- Unchanged content read earlier in the same context may warrant scrutiny.
- Author rereads after edits may confirm changes; discuss that purpose when interpreting them.
- Native tool call/result pairs represent one execution, not two.

## Evidence and uncertainty

- Use output size, elapsed time and native token usage as supporting context, never as proof of waste by themselves.
- When output completeness is unknown, visible size is only a lower bound on what may have reached the agent.
- Ground any plausible shorter navigation route in the task and repository.
- Before claiming a file or guide was available at a block's commit, verify its existence in that history and cite it. You do not need to reconstruct every event.
- Explain contrary evidence and material uncertainty. If limited inspection supports no problem, say **no supported problem was found** and describe the inspection limit; do not declare navigation efficient.

## Report expectations

- Start with a lane-wide narrative. Add block-level detail where notable symptoms are supported.
- Separate **observed behavior**, **interpretation**, and **repository-friction hypotheses** using concise bullets and bold labels.
- When size supports a finding, lead with estimated visible-content tokens, optionally followed by lines. Follow the shared guidance for labeling estimates and their coverage; avoid byte counts as the main measure of possible LLM cost.
- Focus on diagnosis. Specific repository changes are optional.

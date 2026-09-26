# Navigation evidence spike: findings

Status: complete enough to decide whether the active-lane investigation remains viable. The raw fixtures, traces, exports, and analyst inputs were kept under a temporary directory outside the repository and are not part of this record.

## What the spike set out to learn

The investigation needs evidence that lets TARS distinguish a file being named from its contents being shown to an agent, distinguish partial from whole-file reads, preserve repeated search intent and literal queries, recognize compaction boundaries, and attribute a native session to one active lane role. It also needs to establish the smallest analyst input that preserves the task and the relevant navigation evidence.

The probes used a small disposable repository with a configuration change, deliberate shell searches and read variants, an OpenCode partial read followed by a full read, and a separate read-only Codex analyst. They used Codex CLI `0.155.0-alpha.16.4` and OpenCode `1.18.32`.

## Result

The original direction remains viable, with one material change: the evidence index cannot be a uniform event adapter that assumes each harness natively identifies a read. It needs a source-neutral observation layer with explicit confidence and provenance, backed by harness-specific classifiers. Codex can support it using its reduced Rollout Trace's structured terminal-operation records. OpenCode supports it more directly for native tools, but its shell tool needs the same cautious classifier as Codex. This includes ordinary command wrappers: a wrapper such as `rtk` is part of the recorded command, not a reason to discard the operation or call the wrapper itself a read.

TARS can remain a transient reader of harness-owned evidence. It does not need an importer or a durable findings store. AoE does not expose an interactive OpenCode native session ID in its public session metadata, but deterministic attribution is feasible through a per-role launch handshake described below.

## Native evidence inventory

| Capability | Codex Rollout Trace | OpenCode export |
| --- | --- | --- |
| Capture and stable root | `CODEX_ROLLOUT_TRACE_ROOT` created one trace bundle per session; bundle name included the rollout/session ID. `codex debug trace-reduce` produced a 126 KB reduced JSON fixture. | `opencode export <session-id>` produced a 34 KB raw JSON fixture. The raw export contains session, message, and part IDs. |
| Role attribution | Strong if TARS creates a unique trace root for each role and records the launched Codex session ID. | The JSON event stream from `opencode run --format json` includes `sessionID` on every event. An AoE interactive role has no native ID in AoE's public session metadata, but TARS can send a unique, per-role launch prompt, enumerate OpenCode's native sessions, and match the prompt in a raw export. The mapping was proved for two concurrent same-directory roles without using time or path. |
| Ordering and timing | `terminal_operations` have operation IDs, tool-call IDs, request and result records, and start/end sequence and time. `inference_calls` link conversation items and token usage. | Message parts have session/message/part/call IDs and start/end times. Step-finish parts have per-step token and cost fields; session info has aggregate tokens and cost. |
| Native file read | Shell command and output are recorded. The trace does not label a shell operation as a file read. | `read` parts name the file and include displayed `lineStart`, `lineEnd`, `totalLines`, visible text, and truncation. A two-line read had `lineStart: 1`, `lineEnd: 2`, `totalLines: 7`, `truncated: true`; a subsequent whole-file read had `lineEnd: 7`, `truncated: false`. |
| Native search | Shell command and output are recorded; query must be parsed from the command. | `glob` records a pattern. `bash` records its command and output; shell search queries must be parsed from the command. |
| Output and truncation | Result records include stdout, stderr, formatted output, exit status, and requested output budget. This fixture did not establish a reliable native truncation marker for arbitrary shell output. | Tool metadata includes `truncated`; native reads also carry a display range. |
| Compaction | An interactive `/compact` produced one `compaction_request` and one `compaction`. The request carries its request ID, compaction ID, thread and turn IDs, start/end sequence and time, completion status, and raw payload pointers. The installed compaction carries the same compaction ID, `installed_at_unix_ms`, a marker conversation-item ID, request IDs, and input/replacement item IDs. | An interactive `/compact` produced a `part` with `type: "compaction"` and `auto: false`, followed by an assistant message with `agent: "compaction"` and `summary: true`. All records carry stable session/message/part IDs and timestamps. |

The raw OpenCode export is required for navigation analysis. Its `--sanitize` form retained the part structure but replaced every observed tool input with a `redacted` field, removing paths, commands, patterns, and literal queries.

## AoE interactive OpenCode attribution probe

Two AoE-managed interactive OpenCode sessions were launched concurrently in the same disposable repository: one author role and one reviewer role. AoE assigned its own IDs (`fb44bda6777c4d04` and `eabc07de73594ba6`) and reported only those IDs, title, path, tool, command, and state through `aoe session show --json` and `aoe list --json`. The OpenCode TUI and process command line did not display the native session ID.

TARS then sent each AoE role a different harmless first prompt containing a generated marker. `opencode session list --format json` listed two new sessions in the shared directory. Exporting them showed the complete first user prompt and a stable native `sessionID` on every message and part. The author marker appeared only in `ses_f22f7e90dffeUvPIevqDVhs5pY`; the reviewer marker appeared only in `ses_f22f7dd70ffe4dzjec92zYb6x1`. The sessions had overlapping execution time and the same working directory, so this cannot be explained by time or path matching.

The production protocol should therefore be a transient launch handshake: after creating each fresh AoE role, TARS sends a generated role-and-lane nonce as the role's first native OpenCode prompt, polls the supported native session list, and inspects raw exports until exactly one export contains that exact prompt. It records the resulting native ID only in the active lane state. If there are zero or multiple exact matches within the launch operation, investigation coverage for that role is unavailable. The nonce must be unique per role and lane; it becomes ordinary native prompt evidence and must not be placed in the default operator report. This is a deterministic content identity check, rather than a timing or directory heuristic.

## Compaction probe

A disposable interactive session for each harness received one harmless prompt and response, then the `/compact` command. Sending `/compact` to an empty OpenCode session first returned that there was no prior conversation content to compact; a prior exchange is required to create a boundary.

Codex `0.155.0-alpha.16.4` displayed `Context compacted` and its reduced Rollout Trace recorded both the completed request and the installed compaction. TARS can use `compactions[].installed_at_unix_ms` as the reset boundary and retain its `input_item_ids` and `replacement_item_ids` as evidence of what changed. `compaction_requests[]` is supporting provenance, rather than the boundary itself.

OpenCode `1.18.32` displayed an interactive compaction. Its raw export recorded the manual command as a `type: "compaction"` part (`auto: false`) associated with the pre-compaction user message, then recorded the generated summary as an assistant message whose `agent` is `compaction` and whose `summary` is `true`. TARS can use the compaction part's position in the ordered part stream as the reset boundary and retain the following summary message as provenance. The exported session-level `time_compacting` field was not present, so it must not be the primary detector.

AoE could create the disposable Codex probe session but refused to launch it until local agent hook paths are acknowledged in the AoE TUI. That is an environment prerequisite for the separate AoE attribution probe; it does not affect the native compaction formats established above.

## Classification results

| Form exercised | Codex result | OpenCode result | Safe interpretation |
| --- | --- | --- | --- |
| Native whole-file read | `cat path` is present as a terminal operation with stdout, but its extent is inferred rather than declared. | Native `read` declares the full displayed range and total lines. | OpenCode native read can be a confirmed whole-file read. Codex `cat` is an inferred whole-file candidate unless output completeness can be established. |
| Native partial read | `sed -n '1,2p'` and `head -n 2` are separate terminal operations, but range parsing is needed. | Native `read` has line-range and truncation metadata. | OpenCode can classify directly. Codex needs an allowlisted shell parser and should emit unknown for unsupported forms. |
| `rg` / `grep` | Each command, output, and timing is preserved in a structured terminal operation. | `bash` command and output are preserved. | Search intent and literal query are available after parsing. A matching line in output counts as content shown only when the parser can identify the file and line, not merely a path listing. |
| `find` / filename listing | Preserved as a terminal operation. | Equivalent behavior was not exercised as a native tool in this fixture. | Filename-only result: do not add to exploration breadth. |
| Pipeline and compound command | A compound command is preserved in one terminal operation; a parallel batch produces several terminal operations. | Bash is one tool part per command. | Split and classify only forms whose shell semantics are known. Keep the native operation as the evidence pointer; mark unsupported composition as unknown. |
| Allowlisted command wrapper | The terminal operation preserves the full command, including a wrapper such as `rtk`. | A `bash` part preserves the full command. | Retain the full wrapper chain for provenance. When an allowlisted wrapper has a deterministic argument form, unwrap it once to classify the underlying command; otherwise leave the operation unknown. |
| Repeated reads and searches | Ordered terminal operations make within-role recurrence measurable after classification. | Ordered tool parts make it measurable; native reads retain extent. | The index must retain direct observations separately from parser inferences, and reset both counters only at a confirmed compaction boundary. |

The Codex trace has more structure than its chronological conversation alone suggests. `terminal_operations` contain separate request/result records even when the model issued a batched tool call. The first implementation plan should use those records as the primary Codex input, rather than parsing prose-level conversation items.

## Analyst-input experiment

A full reduced Codex trace contained static developer and environment material alongside the actual task, navigation, tool output, and edits. An analyst initially spent its first read on that unrelated bootstrap material. A deterministic projection containing the user task, `terminal_operations`, `compactions`, and `inference_calls` gave a separate read-only analyst enough information to correctly describe the fixture as narrow navigation: one repository listing, one targeted search, reads of the source and test, no documentation content read, and no compaction.

That same analyst incorrectly stated that the selected fields did not show the edit action, even though the complete reduced trace has linked `tool_calls`. This is the practical result: a projection can be the default analyst input, but it must include a validated, question-specific set of linked records. The analyst must be able to request or be given the corresponding edit/tool record when a navigation conclusion depends on it. A generic summary is too lossy; passing the entire raw trace is needlessly noisy for this fixture.

The completed Codex fixture contained 8 terminal operations, 9 tool calls, 7 inference calls, and 26 conversation items. The reduced trace was 126 KB. The OpenCode change fixture contained 8 messages, 34 parts, 10 tool parts, and a 34 KB raw export. These are only small-fixture measurements, so they do not establish a default whole-lane budget. They do establish that cost estimation must be based on serialized selected native records, not just event counts or aggregate harness token metrics.

## What is still unproven

1. The probes establish manual compaction markers, but not automatic compaction under context pressure or the behavior of a resumed/replacement session after compaction. Those cases need a follow-up probe before TARS treats them as equivalent reset boundaries.
2. The first worktree matrix established a conservative initial subset: simple direct commands behind an allowlisted `rtk` wrapper, plus the negative redirection rule. Pipes, substitutions, scripts, aliases, multiple targets, and Codex output completeness remain unsupported. It needs saved-record and parser fixtures for those forms, plus an OpenCode capture that reaches every form under per-operation time limits, before that subset can expand.
3. The analyst experiment used one small, single-role Codex session. It did not test a complete author/reviewer lane, handoff commit attribution, reviewer rereads across changed and unchanged commits, or a long session's budget boundary.

## Follow-up: command-classifier fixture matrix

This is a bounded validation task for the deterministic observation layer. It does not ask an analyst to infer shell semantics at runtime.

1. Create a small disposable repository whose files have distinctive, known contents and line counts. Maintain a fixture manifest that states, for every command, the expected observation: `read`, `search`, `filename-only`, or `unknown`; the files whose contents should count toward exploration breadth; the displayed line extent where knowable; the literal search query; and whether the result is `direct` or `inferred` evidence.
2. Run the same manifest through fresh Codex and OpenCode sessions, retaining their native evidence only for the duration of the probe. The corpus must cover: direct `cat`, `sed`, and `head` reads; `rg` and `grep` searches; filename listings; an allowlisted `rtk` wrapper around each supported form; redirection that prevents command output from being shown to the agent; simple pipes; command substitutions; script invocations; aliases; multiple explicit target files; and deliberately truncated output. Include positive and negative cases for each form.
3. Implement the classifier as a small, non-executing parser over the command string and native result metadata. Compare its emitted observations with the fixture manifest. Do not run, expand, source, or otherwise interpret a recorded command. An alias, substitution, script, redirection, pipeline, wrapper, or output condition is supported only if the parser can recover the relevant command, target, and displayed content deterministically from the native record.
4. For each corpus entry, replay the native record through the adapter and assert the complete result: preserved original command and wrapper chain, evidence pointer, target paths, query, read extent, visibility, confidence, and `unknown` reason where applicable. The cross-harness replay detects both parser defects and harness-schema gaps.
5. Publish the resulting coverage table as the initial supported grammar. For example, a direct native OpenCode `read` can be confirmed from its range metadata; a shell command whose stdout is redirected must not count as content shown; an unrecognizable script or alias is `unknown`. Unsupported forms remain in the ordered trail for provenance but produce no navigation claim. Add each confirmed native record as a regression fixture so a harness upgrade cannot silently broaden or change classification.

The result should be a deliberately narrow, versioned supported subset. This makes the report defensible: it can say that evidence was unavailable or ambiguous instead of treating every shell command that mentions a path as a read.

### First worktree capture

The first matrix capture used a temporary TARS Git worktree, rather than a synthetic repository. It added untracked files with distinctive contents and known line counts, ran the corpus through fresh harness sessions, and retained the resulting native evidence only under `/private/tmp` while this report was updated. The worktree and native sessions are to be discarded after recording these results.

| Form | Codex native record | OpenCode native record | Initial classification decision |
| --- | --- | --- | --- |
| Direct `rtk cat`, `rtk sed`, `rtk rg`, and `rtk find` | All four complete wrapper chains and outputs were preserved. | All four complete wrapper chains and outputs were preserved, with `truncated: false`. | Support direct, allowlisted `rtk` unwrapping only for a fixed set of simple underlying commands. `find` remains filename-only. |
| Redirected `cat` | The command was preserved and stdout length was zero. | The command was preserved and output was `(no output)`. | Support the negative rule: a direct output redirection does not show file content to the agent and does not add exploration breadth. |
| Simple pipe | The requested `cat file | rtk sed -n ...` was preserved and emitted two lines. | The harness changed it to `rtk read file | rtk sed -n ...`. | Preserve the whole command, but classify pipes as `unknown` in the first supported subset. The OpenCode rewrite demonstrates why expected commands cannot be substituted for native records. |
| Command substitution | The requested command and four lines of output were preserved. | The harness changed `cat "$(printf ...)"` to `rtk read "$(printf ...)"`. | `unknown`: TARS must not execute or expand substitutions to discover a target. |
| Alias | The complete alias definition and invocation were preserved; zsh returned exit 127, with no content shown. | Not reached before the bounded session was stopped. | `unknown`; an alias definition is not a deterministic read attribution. |
| Script invocation | The script command and its output were preserved. | Not reached before the bounded session was stopped. | `unknown`; TARS does not inspect or execute a script to attribute its internal reads. |
| Multiple literal targets | `cat alpha beta` and concatenated output were preserved. | Not reached before the bounded session was stopped. | Defer support until the parser has a tested rule for target-to-output attribution and extent. |
| Oversized output | `cat large` yielded 328,894 bytes in the reduced trace, but no reliable truncation field. | Not reached before the bounded session was stopped. | Do not infer a full-file read from `cat` output alone. Codex needs an explicit truncation or completeness signal before it can make that claim. |

OpenCode completed five requested operations and began two later ones before the bounded process was stopped; the raw export showed each observed `bash` record, its command, output, exit status, and `truncated` field. Its changes to the pipeline and substitution commands are first-class probe results. A model-directed fixture cannot serve as the parser's sole oracle because a harness may choose a different command. The regression suite should therefore have two inputs: saved native records for adapter and schema coverage, and hand-authored command-and-result cases for the parser grammar. In both cases, expected observations are defined from the record under test, never from the natural-language instruction that originally produced it.

## Plan impact

Continue with the existing post-spike design activities, but revise them around these findings:

1. Use Codex `terminal_operations`, `tool_calls`, `inference_calls`, and compaction records as the adapter's structured source. Treat conversation items as task/rationale context only.
2. Treat OpenCode native `read`, `glob`, and `bash` parts differently. Native read extent is direct evidence; shell-derived observations are inferences. Preserve command wrappers and unwrap only allowlisted, deterministically parseable wrappers before applying the shell classifier. Use the raw export transiently because sanitization removes required navigation fields.
3. Implement OpenCode AoE attribution as the deterministic launch handshake: role-specific nonce prompt, native session-list polling, raw-export exact-prompt match, and active-lane-only native ID. Never substitute time or directory matching. Use the observed manual-compaction records as reset boundaries, but retain an explicit coverage gap for unsupported automatic or resumed-session compaction semantics rather than guessing.
4. Design the transient index around native evidence pointers plus classified observations with `direct`, `inferred`, or `unknown` confidence. Its exact high-level shape remains a post-spike plan activity, as requested.
5. Give the analyst a validated question-specific projection and read-only repository access. Include linked edit records and each block's task/handoff context. Do not rely on a prose summary or supply the full trace by default.

No post-spike implementation or design work has been started from these findings.

# Progressive investigation implementation

Status: all five implementation iterations are completed and pushed. Updated 2026-10-14 for [issue #18](https://github.com/satwikhebbar/tars/issues/18).

This is the primary implementation record for active-lane investigations. It supersedes the earlier active-lane plan (retained in Git history), including its transient projection and token-budget gate. Each iteration was independently tested and committed, followed by operator review and a local smoke check before pushing. Iteration-specific notes below retain the conditions and limitations at the time of each check; the current contract is summarized here.

## Current design and responsibility boundary

- Investigations cover active, capture-enabled Codex/OpenCode lanes. Both roles must be idle or waiting at launch and both evidence sources must be available or partial. An absent role source stops analyst launch; smaller gaps remain visible. Closed lanes and retroactive capture are unsupported.
- TARS collects harness-owned evidence into a disposable, immutable SQLite cache. Native stores remain authoritative. Reuse is presence-based, without checking for newer activity; `lane evidence --force` creates a new snapshot. Expiry is seven days from creation, with size reporting and explicit listing/deletion/pruning. Cleanup never deletes native harness stores.
- TARS preserves every field in the chosen OpenCode export or Codex reduced JSON, labels upstream limitations, and normalizes individual factual events. It does not derive reread candidates, interpret deployments, judge efficiency, expose SQL/group-by, or track which evidence the analyst inspected.
- One Codex analyst receives a bounded outline, progressive CLI access, and read-only repository access, including history. It chooses what to inspect and aggregate, judges patterns in task context, and authors the report. Its harness manages context and may delegate within the same permission boundary; TARS does not track session token use or split analysis into block agents.
- Built-in questions supply versioned instructions; ad hoc questions supply operator text and optional report guidance. Both share retrieval guidance, the structured answer-file protocol, validation and Markdown rendering. Repository navigation efficiency is the first built-in; the ad hoc handoff smoke checked extensibility, not an additional built-in product requirement.
- The analyst returns JSON containing Markdown prose and inline citation markers backed by a structured registry. TARS validates shape, snapshot/question identity, block/event references and repository commit/path existence, permits one correction, and renders the report. It does not validate substantive conclusions, line meaning or reading coverage. Partial conclusions explain material limits without an inspected-event/block ledger.
- Reports identify snapshot time and coverage cutoff. Later lane activity does not change a running investigation. Event citations are snapshot-local and need not survive cache expiry; the rendered report explains how to look them up. Reports are printed and optionally exported, rather than retained as a TARS findings store.

## Implementation sequence

1. **Dispatch boundaries — completed and pushed.** Journal unique IDs, match delivered native messages, build lane-wide intervals, and retain approximate boundaries for older lanes. Issue 75 smoke assigned all 109 navigation events, including the author's post-approval activity; new ID matching is covered by fixtures.
2. **SQLite storage foundation — completed and pushed.** Add immutable snapshots, source/block/event/content tables, content deduplication, a versioned native normalization inventory, lossless chosen-artifact reconstruction, atomic publication, seven-day expiry, forced refresh, listing and deletion APIs. This is a library iteration; the existing CLI remains the smoke surface for lane behavior. New storage tests use both harness fixtures and isolated temporary cache directories. At this stage, no analyst or operator CLI read this database; iterations 3–5 connected it.
3. **Connect collection and cache lifecycle — completed and pushed.** Connect both native-source collectors and block attribution to the storage foundation. Replace `lane evidence --index` with ordinary snapshot preparation and `--force`; expose indexes/remove-index/prune-indexes. Retain source availability and upstream gaps, incorporate dispatch markers without prompt duplication, and handle large exports. Serialize cache mutation, implement analyst lease acquisition/release and crash recovery before enabling automatic deletion around readers. Live smoke: create issue 75 snapshot, reconstruct/compare artifacts, reuse without exports, force a second snapshot, verify sizes, and clean up only the selected cache.
4. **Progressive read-only CLI — completed and pushed; automated and live smoke checks passed.** Implement snapshot-bound overview, event filters, content ranges and extra-field queries, opaque filter-bound cursors, bounded serialized response sizes and local token estimates. Add context-segment/compaction references and opening native-message IDs to blocks. All bodies and oversized metadata remain accessible through references. Test pagination, exact path/query semantics, Unicode, unusual native fields, and long fixtures. Live smoke: page both roles of issue 75, retrieve selected bodies and confirm limits and stable ordering.
5. **Questions, report and analyst — completed and pushed; automated and live smoke checks passed.** Implement common dispatch guidance, navigation built-in and ad hoc questions, structured answer-file protocol, hybrid inline citations, self-validation CLI and deterministic Markdown rendering. Use a separate Codex analyst with read-only repository/cache access and a writable private answer directory. Reuse preparation implicitly; require both role sources; remove the whole-projection budget gate. Validate final answers and permit one correction in the same session. Smoke a real investigation, inspect its evidence and report, confirm main role sessions are untouched, and test cleanup.

## Storage foundation contract

Snapshots live under `$XDG_CACHE_HOME/agent-review-loop/evidence-indexes/<hashed-lane-id>/<snapshot-id>/evidence.sqlite`, defaulting to `~/.cache`. Hashing the lane key permits worktree paths without directory traversal. An adjacent private manifest records source metadata, cutoff, size, version and fixed expiry. Native stores remain authoritative. Staging directories are excluded from reuse; ordinary collection/SQL errors remove staging. Process termination may leave an ignored staging directory; recovery/pruning of those directories belongs to iteration 3.

`sources.native_json` preserves the entire chosen export or reduced trace as a tree of values and internal references. `events.extra_json` preserves the individual native record; long identical strings across both representations share one content ID. The content table chunks those strings without splitting Unicode code points. Short strings and structural metadata may repeat; this is content deduplication, not a byte-identical native file archive. Reconstruction preserves JSON field values, including uncommon records. The reader opens SQLite read-only.

The executable normalization inventory is `lib/investigation-records.mjs`. It labels message, tool-call, compaction, native-accounting and unknown records and reuses the existing conservative per-command classifier. Terminal operation and native tool-call records remain separate, linked when their native call IDs agree. They must not be counted as two executed commands. Source-level session metadata is also preserved. The library does not compare reads, group queries or derive findings.

At the end of iteration 2, analyst content descriptors, bounded pages, context segments, and complete block assignment were not yet exposed for this generic timeline. Those are required before switching investigation to the new store. The existing block module remains the authority for intervals; iteration 3 connects it to every normalized timeline record. The current collector's 16 MiB OpenCode diagnostic limit is unchanged until iteration 3.

## Iteration 3 implementation notes

`lane evidence` now prepares/reuses a snapshot, with `--force` rebuilding it;
`lane indexes`, `lane remove-index --snapshot-id`, and `lane prune-indexes`
expose the cache lifecycle. Presence-based reuse does not contact AoE or native
sources. Collection still requires both sessions quiet; missing sources and
historical gaps are recorded, with both-role requirements left to the eventual
analyst launch. A lane key uses its initial dispatch marker (or its pair IDs for
legacy lanes without that marker) to avoid reuse across lane relaunches.

Generic events use the existing dispatch intervals. Matched opening messages
belong to the new block even at its exact start timestamp; unrelated ties and
untimed records remain unassigned. Dispatch journal metadata is indexed without
copying prompt or handoff file bodies. Blocks expose opening and dispatch event
IDs when available. Context segments remain iteration 4 work.

A cache-level SQLite write transaction serializes mutations and releases on
process death. Reader lease acquisition/removal shares that lock with cleanup.
Dead local owners are reclaimable; unknown/foreign owners conservatively pin
the snapshot. Pending leases are published atomically. Interrupted staging and
pending lease directories are removed by the next mutation. The native JSON
outputs remain temporary regular files; full snapshot collection removes the
16 MiB diagnostic cap, but JSON parsing still uses memory proportional to the
artifacts. Streaming JSON parsing remains a future optimization.

Automated verification covers cache reuse/force, CLI cleanup, both harnesses,
large exports, block association, historical gaps, changing dispatch journals,
concurrent publishers, leases and SIGKILL recovery. The isolated staged checkout passed all 205 automated tests (13 new lifecycle/CLI tests). The planned live check below covers the
issue 75 smoke against an isolated cache: create/reuse/force, inspect source
reconstruction and block assignment, report size, and remove the test snapshots.

### Iteration 3 live smoke — 2026-10-11

Passed against an exported checkout of committed iteration 3 (`1015b8c`), with
the real issue 75 lane, a read-only lane registry connection, and an isolated
cache. Author was idle; reviewer was waiting. No prompts were sent.

- Both sources available, no reported gaps: OpenCode export 1,091,417 bytes / 75
  messages; Codex three bundles / 1,722,797 reduced bytes. Reconstructed all four
  native artifacts from SQLite and compared them with the collected JSON.
- Snapshot 3,710,976 bytes, 514 events, five sources including the dispatch
  journal, four blocks; 467 events assigned to blocks. Journal reconstruction
  and dispatch-event block references checked. This older lane has approximate
  journal boundaries and unanchored initial blocks; exact native dispatch
  matching remains covered by automated fixtures.
- Reuse returned the same snapshot with zero additional AoE or export/reduction
  calls. Force created a distinct snapshot of the same size/event count while
  the old snapshot remained readable. Expiry was exactly seven days.
- CLI listed both snapshots with sizes. Removing a leased snapshot failed;
  after closing its reader and releasing the lease, removal succeeded and the
  other snapshot remained available. Pruning removed zero unexpired snapshots.
- Removed the remaining snapshot; CLI inventory empty. Temporary collector
  outputs gone. Lane registry/journal unchanged; Codex native file sizes,
  modification times and manifest hashes unchanged. Cache management commands
  did not create a state database. The isolated cache was deleted.

The initial smoke wrapper routed OpenCode through an extra `rtk proxy` process
and reproduced its known 65,536-byte export truncation. Using the production
collector's direct regular-file stdout resolved this test-harness problem; no
product changes were needed. Live smoke is complete; iteration 3 is pushed.

## Iteration 4 implementation notes

The four JSON query commands sit under `lane evidence`: `overview`,
`list_events`, `get_event_content`, and `get_event_details`, each bound to a
snapshot ID. This iteration exposes evidence retrieval only; it does not
launch an analyst or replace the existing investigation path yet.

Snapshot version 3 adds indexed factual filter columns and an `event_fields`
tree. Each field has an event-local stable ID, parent ID, native key, ordinal,
kind, and scalar value/content reference. Objects/arrays are traversed one
level at a time. This makes every uncommon field accessible without eagerly
serializing it into a details response. Storage chunks stay internal. Large
native field keys have a separate key-text retrieval mode. Both artifacts
remain reconstructible through the existing native representation.

Filters run before pagination and combine with AND. Paths match any normalized
target; subtree matching respects separators. Search queries remain exact.
Source/message filters allow traversing an OpenCode parent message's parts.
Stable source ordering uses OpenCode native positions and Codex timestamps
where known. Context IDs are independent per native source; compaction IDs
accompany later events. Untimed/tied Codex attribution is unknown, rather than
inferred. Source bundles are not assumed to share uninterrupted context.

Every success response is measured after final JSON serialization, including
the newline: 16 KiB / 4,000 estimated tokens for overview/events/details;
8 KiB / 2,000 for content. Opaque cursors bind to snapshot/version, command,
filters, field and range. Byte ranges preserve UTF-8 character boundaries;
long selected lines still paginate. The pinned `js-tiktoken` dependency uses
local `o200k_base` ranks. A labeled four-character fallback handles missing
dependencies without transmitting evidence. Token estimates cover only the
returned response.

Operator queries briefly lease snapshots; the library/CLI can instead borrow
a live launcher's lease for fully read-only analyst queries. Query commands
bypass the lane state database. The future analyst launcher owns/relinquishes
the lifetime lease; no evidence access ledger is introduced.

Automated tests cover long timelines, filters, cursors, Unicode and oversized
lines, unknown/deep/wide fields, parent-message references, compaction context,
response serialization and token estimates, CLI isolation and lease cleanup.
The isolated staged checkout passed all 225 automated tests, including 20 new
retrieval tests; it excludes the earlier uncommitted analyst implementation.
Live smoke before pushing: rebuild issue 75 into a version-3 isolated cache,
page both roles and block inventory, retrieve native message/output/detail
fields, verify every byte/token cap and stable ordering, then remove the cache.

### Iteration 4 live smoke — 2026-10-11

Passed against exported commit `a39969b`, using lane 75's real native evidence,
a read-only registry connection and an isolated version-3 cache. No session
prompts were sent.

- Both sources available: 514 events, four blocks. Paged the whole timeline
  and each role separately, checking exact stored order and unique IDs without
  omissions. Overview counts, boundary confidence and cutoff matched SQLite.
- Combined role/block/event-type/tool/output-size filters and exact path
  filters matched stored facts. Cursors rejected changed filters and a
  different snapshot.
- Retrieved field details and reconstructed a large native output exactly
  across 270 content pages. A selected line range also spanned pages and
  reconstructed exactly. All 499 successful responses met their respective
  byte/token caps, measured with the local tokenizer: maximum response size
  10,949 bytes, maximum estimated tokens 3,999.
- Exercised the committed CLI with a borrowed reader lease. Snapshot hash and
  lane registry/journal were unchanged; temporary leases were released. Removed
  both test snapshots. The isolated cache was 12,877,824 bytes for lane 75.
- This older lane has no matched opening-message excerpts or compaction events;
  those cases remain verified by automated fixtures, not this live smoke.

The first line-range assertion incorrectly expected a large selected range in
one page. Following its continuation cursors fixed the smoke harness; no
product changes were required.

## Iteration 5 implementation notes

`lane investigate` now prepares/reuses a snapshot and launches one constrained
Codex analyst, including for OpenCode-authored lanes. It rechecks quiet AoE roles
before launch even when preparation reuses cached evidence. Both sources must be
available or partial; absent role sources stop launch, while smaller gaps remain
visible. No whole-projection budget gate or selected-block mode remains.

The built-in registry is instructions-only, with versioned navigation guidance in
`questions/navigation-efficiency.md`. Ad hoc question text and optional report
guidance reuse the common prompt, evidence tools and report validator. The opening
prompt contains one bounded overview page, paging/filter syntax, scope and evidence
rules, the structured answer shape, and an assigned file/self-validation command.

The launcher owns a lifetime snapshot lease. Evidence and report-validation CLI
commands borrow it read-only and bypass the lane registry. The private run directory
is the only model-writable root: explicit sandbox settings disable other roots,
shared temporary writes, tool network access and approval escalation on launch and
resume. Codex user config/rules are ignored. The lane's Codex model (or an explicit
`--analyst-model`) is used, without forwarding an OpenCode provider model.

The analyst authors the structured JSON and Markdown prose. Validation checks
required fields, snapshot/question identity, scope, inline citation registry usage,
block/event existence and local Git commit/path existence. It does not assess
substance, citation line meaning, or the analyst's reading history. A partial
report is supported. The file is bounded to 1 MiB and must be a regular file, not
a symlink. TARS reads its assigned path, not a path from the completion message.
One correction resumes the captured JSONL thread ID with the same explicit sandbox
and model. Validated Markdown preserves inline citation placement and includes the
snapshot cutoff. Export uses exclusive creation.

Process stdout streams to a private temporary JSONL file. Normal return, process or
validation error, timeout and handled interruption remove run files and release the
lease. SIGKILL leaves a reclaimable dead-owner lease and may leave an OS temporary
directory; this is not a retained TARS report store. Live smoke remains a separate
pre-push check: run lane 75 investigation, inspect its grounded report, self-validator
and progressive reads, confirm role sessions/native evidence unchanged, and check
run-directory/lease cleanup. Do not push until that smoke is approved and complete.

Automated verification: 22 new tests cover question resolution, schema/inline
citations, repository references, self-validation CLI isolation, actual child-process
stdin/file output, interruptions/timeouts, correction/resume settings, both-role
coverage, partial reports, export protection and the CLI flow with a stub harness.
An isolated checkout of the exact staged files passed all 247 tests;
the old uncommitted projection/analyst drafts were replaced by this implementation.
Earlier unrelated index/spike edits remain outside the iteration commit.

### Iteration 5 additional verification

Added 10 tests for the subprocess file protocol (real progressive evidence and
self-validation CLI calls), failed corrections, assigned-context tampering, snapshot
isolation, quoted paths, inline citation placement, CLI cancellation including
descendants, and failed/racing exports. The existing export test also asserts that
an existing destination prevents analyst launch and retains its contents.

The cancellation integration test exposed abort-signal forwarding as a command
property instead of the process runner's second argument; this is corrected.
Existing export destinations now fail before analyst launch; exclusive creation
still protects against a destination appearing during analysis.

All 257 automated tests pass. Live Codex permission enforcement and the actual
lane 75 report remain the separate pre-push smoke gate.

### Iteration 5 live smoke — 2026-10-12

Passed against the committed implementation at `01b267c`, using lane 75's live
author/reviewer sessions, a copy of the lane registry, and an isolated cache. The
snapshot contained 514 events across four blocks and five sources, occupied
12,877,824 bytes, and had both role sources available. Its ID was
`6cd5dd76-f1cb-40ad-a61f-5b1d2adf3414`.

| Check | Result |
| --- | --- |
| Live Codex permission boundary | Evidence CLI and repository metadata reads succeeded; private output was writable; exclusive sentinel writes to repository and cache were denied with `EPERM`. The probe analyst repaired an initial shell quoting error before completing the successful check. |
| Built-in navigation question | 18 successful shell commands, including paged/filtered evidence, details/content retrieval and actual CLI self-validation; validated report rendered with inline citations and snapshot cutoff. |
| Ad hoc handoff question | 18 successful shell commands and actual CLI self-validation; report described the author/reviewer relay, with approximate/unanchored boundaries explained. |
| Explicit analyst model | Ad hoc invocation supplied `--analyst-model gpt-5.6-terra`; recorded Codex launch arguments confirmed it, without forwarding the OpenCode model. |
| Markdown export | Navigation (5,207 bytes) and ad hoc (4,260 bytes) exports exactly matched their CLI output. |
| Existing export destination | Immediate `EEXIST`, no analyst launch, no file change. |
| Live cancellation | SIGINT after the first evidence command began produced a clear interruption failure, no Markdown output, removed answer directory, and terminated all four recorded processes in the analyst tree. |
| Cleanup and original lane | No reader leases remained; both completed analyst directories were removed. Live lane row, dispatch journal, repository status, OpenCode native export and all 101 Codex trace files were unchanged. Author remained idle; reviewer remained waiting. |

The reports passed reference/schema validation and were inspected for evidence use
and uncertainty disclosure; this smoke is not an independent verification of every
analyst judgment. The isolated cache and test checkout were removed after verification.
Operator Markdown exports remain at `/tmp/tars-iteration-5-smoke-reports/` for review.
The live smoke gate for iteration 5 is complete; the automated suite already passed
all 257 tests in an isolated checkout of the exact staged implementation.


## Design evidence retained from the proposal and spike

The October 2026 issue 75 prototype motivated progressive retrieval:

- Its original analyst projection was 831,672 **bytes**, incorrectly labeled as tokens by the old budget gate. Visible tool output was approximately 51% and conversation bodies 32%. Removing identified duplicate bodies/commands saved only 12.5%; deduplication alone could not make whole-lane projections scale reliably.
- A compact offline inventory represented 109 tool events and 103 conversation items in six metadata pages. One analyst used 36 evidence calls and produced a grounded partial report. This demonstrated utility, not complete source coverage or a general token-savings ratio.
- Eight eager `details` responses accounted for 345,020 bytes, approximately 68% of the prototype's 506 KB of CLI output. This established the need to measure **every serialized response**, including details, and move large native fields behind paged references. Long single lines also required UTF-8-safe byte fallback alongside line ranges.
- Opening outlines must match actual dispatch messages rather than select the first native user messages, which can be injected environment/instruction context. Unique journaled dispatch IDs enable matching; older lanes retain labeled approximate boundaries. Codex message bodies can be structured objects and must remain losslessly accessible.
- Permission probes established a private writable answer directory with repository/cache access read-only. Same-session correction required explicit sandbox settings on resume as well as launch. The formal live smoke subsequently verified these boundaries and cleanup.

Earlier source feasibility probes also established:

- OpenCode 1.18.32's loopback server `POST /session` returned an exact native ID. AoE custom launch with `opencode attach <url> --session <id>` performed a read whose export matched that ID. AoE stop/start and server restart using the same native store preserved attribution. AoE rejects combining `--cmd` and `--tool`. These results justified direct launch-time attribution rather than scanning every session export; they are historical tested-version observations, not guarantees for all harness versions.
- Issue 58's Codex reviewer trace contained two review rounds at different commits: nine tool calls for the first review and four for the follow-up. This proved persistent-session evidence across handoffs and the need to join dispatch/commit context. Its unavailable OpenCode export prevented treating it as a complete lane sample.

## Follow-up verification and operator feedback — 2026-10-12

Commit `9876a0d` refined the analyst prompt with a TARS glossary, task-based CLI guidance, an explained assignment/context file, and a single question presentation. Navigation instructions now introduce the problem and group analysis guidance for human review. Harness delegation is permitted within the analyst's existing permissions.

Snapshot format 4 caches local token estimates for stored content. Large text is counted in bounded chunks, preferring whitespace boundaries and preserving Unicode; these are labeled estimates, not exact billed usage. Content queries distinguish returned-page estimates from total stored-content estimates. The analyst does not need to write its own counting script. The automated suite passed all 261 tests, including chunking, estimates and prompt/citation checks.

A fresh built-in navigation investigation against idle lane 75 succeeded using snapshot `69b5072d-0315-4079-9ea8-2e5308bff9d5` (13,111,296 bytes; collected 2026-10-12T12:49:53.155Z; cutoff 2026-10-12T12:49:49.318Z). The analyst completed 20 commands and returned a validated whole-lane report. It distinguished focused author navigation from broad reviewer output and handoff-discovery friction, using token estimates and citing evidence. This confirms the refined path works on that sample; it does not independently prove the analyst's judgments. The operator export was `/tmp/tars-lane-75-navigation-2026-10-12.md`; temporary report paths and cache citations are not durable archival dependencies.

Commit `c51e850` documented capture, investigations, ad hoc questions, cache refresh/cleanup, citations and prompt locations in both READMEs.

## Remaining limitations and deferred work

- Automatic-compaction observability remains an open test item; assume manual-compaction semantics until verified. Missing boundaries or child-agent evidence must remain material source limits rather than invented certainty.
- Long-lane fixtures verify retrieval bounds and ordering; useful synthesis over much longer real lanes remains unproven. Page caps bound individual responses, not cumulative analyst context or cost.
- Full-text search, direct SQL/group-by access, selected-block investigation runs, multiple analyst sessions and real-time anomaly alerts are deferred. The generic event/field/content structure leaves room for later questions without changing collection.
- Codex reduced JSON may omit raw trace payloads. Bundle-versus-reduction fidelity is a follow-up, not a claim of full harness fidelity. Whole-file JSON parsing still uses memory proportional to source artifacts; streaming parsing is a future optimization.
- Unsupported shell forms, including complex wrappers, pipelines, substitutions and multi-target commands, remain preserved but unclassified until fixture-backed normalization is added. TARS does not silently expand its supported grammar for a new question.
- Version one uses Codex analysts for either author harness. OpenCode analyst permission enforcement requires separate verification before support is added.

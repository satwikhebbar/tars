# Progressive investigation implementation

This sequence implements the decisions in [the progressive evidence proposal](proposal-progressive-investigation-evidence.md). It supersedes the earlier plan's transient projection and token-budget gate. Each iteration is independently tested and committed, followed by operator review and a local smoke check before pushing.

1. **Dispatch boundaries — completed and pushed.** Journal unique IDs, match delivered native messages, build lane-wide intervals, and retain approximate boundaries for older lanes. Issue 75 smoke assigned all 109 navigation events, including the author's post-approval activity; new ID matching is covered by fixtures.
2. **SQLite storage foundation — completed and pushed.** Add immutable snapshots, source/block/event/content tables, content deduplication, a versioned native normalization inventory, lossless chosen-artifact reconstruction, atomic publication, seven-day expiry, forced refresh, listing and deletion APIs. This is a library iteration; the existing CLI remains the smoke surface for lane behavior. New storage tests use both harness fixtures and isolated temporary cache directories. No analyst or operator CLI reads this database yet.
3. **Connect collection and cache lifecycle — completed and pushed.** Connect both native-source collectors and block attribution to the storage foundation. Replace `lane evidence --index` with ordinary snapshot preparation and `--force`; expose indexes/remove-index/prune-indexes. Retain source availability and upstream gaps, incorporate dispatch markers without prompt duplication, and handle large exports. Serialize cache mutation, implement analyst lease acquisition/release and crash recovery before enabling automatic deletion around readers. Live smoke: create issue 75 snapshot, reconstruct/compare artifacts, reuse without exports, force a second snapshot, verify sizes, and clean up only the selected cache.
4. **Progressive read-only CLI — implemented, awaiting review and live smoke.** Implement snapshot-bound overview, event filters, content ranges and extra-field queries, opaque filter-bound cursors, bounded serialized response sizes and local token estimates. Add context-segment/compaction references and opening native-message IDs to blocks. All bodies and oversized metadata remain accessible through references. Test pagination, exact path/query semantics, Unicode, unusual native fields, and long fixtures. Live smoke: page both roles of issue 75, retrieve selected bodies and confirm limits and stable ordering.
5. **Questions, report and analyst.** Implement common dispatch guidance, navigation built-in and ad hoc questions, structured answer-file protocol, hybrid inline citations, self-validation CLI and deterministic Markdown rendering. Use a separate Codex analyst with read-only repository/cache access and a writable private answer directory. Reuse preparation implicitly; require both role sources; remove the whole-projection budget gate. Validate final answers and permit one correction in the same session. Smoke a real investigation, inspect its evidence and report, confirm main role sessions are untouched, and test cleanup.

## Storage foundation contract

Snapshots live under `$XDG_CACHE_HOME/agent-review-loop/evidence-indexes/<hashed-lane-id>/<snapshot-id>/evidence.sqlite`, defaulting to `~/.cache`. Hashing the lane key permits worktree paths without directory traversal. An adjacent private manifest records source metadata, cutoff, size, version and fixed expiry. Native stores remain authoritative. Staging directories are excluded from reuse; ordinary collection/SQL errors remove staging. Process termination may leave an ignored staging directory; recovery/pruning of those directories belongs to iteration 3.

`sources.native_json` preserves the entire chosen export or reduced trace as a tree of values and internal references. `events.extra_json` preserves the individual native record; long identical strings across both representations share one content ID. The content table chunks those strings without splitting Unicode code points. Short strings and structural metadata may repeat; this is content deduplication, not a byte-identical native file archive. Reconstruction preserves JSON field values, including uncommon records. The reader opens SQLite read-only.

The executable normalization inventory is `lib/investigation-records.mjs`. It labels message, tool-call, compaction, native-accounting and unknown records and reuses the existing conservative per-command classifier. Terminal operation and native tool-call records remain separate, linked when their native call IDs agree. They must not be counted as two executed commands. Source-level session metadata is also preserved. The library does not compare reads, group queries or derive findings.

Iteration 2 does not yet expose analyst content descriptors, bounded pages, context segments, or complete block assignment for this generic timeline. Those are required before switching investigation to the new store. The existing block module remains the authority for intervals; iteration 3 connects it to every normalized timeline record. The current collector's 16 MiB OpenCode diagnostic limit is unchanged until iteration 3.

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

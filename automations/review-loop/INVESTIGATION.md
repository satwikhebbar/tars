# Active-lane investigation

This guide covers the optional investigation capability: how to enable capture, collect and query evidence, run an analysis, interpret reports, and understand capture behavior. TARS keeps investigation data in native harness stores and temporary or cached local evidence as described below.

## Investigate an active lane

Investigations help an operator reflect on how a lane's author and reviewer
worked. The built-in **repository navigation efficiency** question examines
repeated reads/searches, the breadth of files explored, and large outputs in
the context of the task. It reports observed behavior, supporting evidence,
and possible repository friction; the analyst decides whether that behavior
suggests avoidable effort. You can also ask an ad-hoc question.

### Quick start

Enable capture when creating a new lane:

```bash
tars lane start \
  --repo /absolute/path/to/main-checkout \
  --issue 21 \
  --author opencode --reviewer codex \
  --planning never \
  --investigate capture
```

Once both roles are idle or waiting, generate a report:

```bash
tars lane investigate --issue 21 --output /absolute/path/to/navigation-report.md
```

This collects evidence automatically if there is no usable cached snapshot,
launches a read-only Codex analyst, validates its answer, and prints the
Markdown report while saving it to the requested file. Omit `--output` for
terminal output only. The destination must not already exist.

To investigate activity that occurred since an earlier collection, refresh
the snapshot first:

```bash
tars lane evidence --issue 21 --force
tars lane investigate --issue 21 --output /absolute/path/to/navigation-report-new.md
```

Investigations support active, capture-enabled lanes only, with Codex/OpenCode
in both roles. They do not investigate closed lanes or enable capture
retroactively for an already-running pair. Codex must also be installed and
authenticated to run the analyst, including for an OpenCode-authored lane.
Both roles' evidence is required for investigation; smaller recorded gaps
remain visible to the analyst. The analyst uses your harness account and
incurs model usage.

### Capture and cached evidence

To prepare a newly launched Codex/OpenCode lane for active-lane investigation,
add `--investigate capture`. TARS configures native capture before either role
starts. Native harness stores remain authoritative.

`tars lane evidence --issue <number>` (or `--worktree <path>`) builds an
immutable local SQLite snapshot when none is usable, checking that both AoE
roles are idle or waiting before and after collection. It reports snapshot ID,
cutoff, expiry, database size, source availability, and coverage gaps. A missing
role does not hide the other role's evidence. This command requires an active,
capture-enabled lane. It reuses an existing snapshot without exporting or
checking for newer evidence; `--force` creates a fresh snapshot. Reuse does not
extend expiry. The former `--index` option has been removed.

Snapshots live under
`$XDG_CACHE_HOME/agent-review-loop/evidence-indexes/<hashed-lane>/<snapshot-id>/`,
defaulting to `~/.cache/agent-review-loop/evidence-indexes/`. Each private
directory contains `evidence.sqlite` and `manifest.json`. A shared
`cache-lock.sqlite` serializes collection and cleanup. Snapshots expire seven
days after creation; preparation and `tars lane prune-indexes` remove expired,
unleased snapshots. `tars lane indexes` lists snapshot IDs, sizes, expiry, and
paths. `tars lane remove-index --snapshot-id <id>` removes only that snapshot.
Cleanup never removes native exports or Codex trace bundles. Reader leases pin
snapshots until release; dead local reader processes and interrupted staging
builds are recovered during cache mutation.

OpenCode exports and Codex reduced traces first go to private temporary files,
removed on success or failure. Snapshot collection accepts OpenCode exports
above the old 16 MiB diagnostic limit. JSON parsing and indexing still require
memory proportional to the selected artifacts. The cache preserves all fields
of the chosen JSON artifacts, with shared large strings stored in bounded
chunks; reduced traces can omit upstream raw payloads. The versioned event
normalization inventory is `lib/investigation-records.mjs`. Unsupported commands
remain available as native data. TARS derives individual event facts and
assigns events to dispatch intervals, with approximate boundaries labeled for
older lanes. Journal markers contain metadata and refer to native opening
messages; they do not copy dispatch prompts. This command offers no navigation
judgment. Use `lane investigate` for analysis or the progressive queries below
to inspect the evidence directly.

### Progressive evidence queries

Use the snapshot ID printed by `lane evidence` for read-only queries:

```sh
tars lane evidence overview --snapshot-id <id>
tars lane evidence list_events --snapshot-id <id> --role author --action search
tars lane evidence get_event_details --snapshot-id <id> --event-id <event-id>
tars lane evidence get_event_content --snapshot-id <id> --event-id <event-id> --field <field-id> --line-start 1 --line-end 20
```

Responses are JSON. Pass `--cursor <nextCursor>` with the same command and
filters to continue. The event listing supports block, source, message, role,
event type, tool name, normalized action, exact path, directory subtree, exact
search query, minimum visible output bytes, and inclusive timestamp filters.
Path/query comparisons are literal and case-sensitive; subtree matching uses
a directory separator, so `src` does not match `src-old`. Paths are not
resolved against the current filesystem. There are no regex, aggregation or
SQL commands. Records without classified paths remain in the unfiltered list.

Events carry native source position, compaction context, block uncertainty,
typed attributes and content-field references. Ordering is stable within each
source: OpenCode native record order; Codex known timestamps then native
position, with untimed records last. Different sources have independent
context IDs. Uncertain Codex compaction ordering is reported as unknown.
Paired Codex tool/terminal records remain separate and linked; counts describe
records and must not be interpreted as counts of executed commands.

`get_event_details` lists one level of native fields. Use a returned field ID
or `--field-path <JSON-pointer>` to descend into an object/array. Large values
remain references. `get_event_content` retrieves string fields by ID; it
supports one-based inclusive line ranges or zero-based byte ranges with an
exclusive end. Text with no line breaks uses byte ranges. A selected range may
still require multiple pages; byte endpoints must land on UTF-8 character
boundaries. Long native field names are accessible with `--field-key` and
their field ID. OpenCode parent message events expose references to their
text parts and a source/message filter to retrieve all parts.

Text-field references in events/details include `contentTokenEstimate` for
the full stored text, computed once during indexing. Content responses include
`contentTokenEstimate` for the returned text and `totalContentTokenEstimate`
for the full stored body (or field key). Each estimate names its method and
scope. Long bodies are counted in bounded pieces, preferring whitespace boundaries,
and labeled `chunked-estimate`;
token boundaries can make these totals differ from counting the text in one
pass. Upstream truncation or omissions still limit what the stored body represents.
These content estimates are separate from serialized response estimates and
native harness usage, and do not establish exact billed cost. Snapshot format
4 adds cached estimates; older snapshots are not reused and are rebuilt on
the next evidence collection.

Overview/events/details responses are capped at 16 KiB and 4,000 estimated
tokens; content responses at 8 KiB and 2,000 estimated tokens. Caps include
the final JSON envelope, escaping and stdout newline. Page sizes follow these
limits rather than an event-count limit. Each response reports its serialized
bytes, estimated tokens and counting method. Install the pinned local
tokenizer with:

```sh
npm --prefix automations/review-loop ci --ignore-scripts
```

The tokenizer uses locally installed `o200k_base` ranks; no evidence is sent
to a provider or downloaded during queries. When unavailable, responses label
the fallback estimate of four characters per token. Estimates describe the
response and are not a measurement of the analyst's model or session context.

Operator queries acquire a short reader lease and release it after closing
SQLite. The analyst launcher holds a lease for the entire analysis;
queries borrowing that lease perform no cache writes. Queries open no lane
state database and never re-collect sources.

### Questions and reports

Run `tars lane investigate --issue <number>` (or `--worktree <path>`) for
repository navigation diagnosis. The default built-in is `navigation-efficiency`;
its versioned instructions live in `questions/`.
Use `--ad-hoc "<question>"` with optional `--report-guidance "<instructions>"`
for another question. Both modes share evidence retrieval, analysis guidance,
report structure and validation.

```bash
# Explicitly select the built-in question and analyst model.
tars lane investigate --issue 21 \
  --question navigation-efficiency --analyst-model <codex-model> \
  --output /absolute/path/to/navigation-report.md

# Ask your own question using the same evidence and report protocol.
tars lane investigate --issue 21 \
  --ad-hoc "Did the author and reviewer follow the task's stated constraints?" \
  --report-guidance "Distinguish observed actions from uncertain interpretations." \
  --output /absolute/path/to/constraints-report.md
```

Reports contain scope, a summary, findings, limitations, and a conclusion.
They may declare partial scope when the analyst cannot support a whole-lane
conclusion. Content sizes use labeled token estimates where available, rather
than claiming exact billed usage. Event citations are snapshot-local IDs;
the report includes a command for looking them up while the cache exists.
Repository citations identify a commit and path, with an optional line.

To review or change the instructions, see the
[shared analyst prompt](lib/investigation-analyst.mjs),
[built-in navigation guidance](questions/navigation-efficiency.md),
and [question registry](lib/investigation-question.mjs).
Ad-hoc question text and optional report guidance replace the built-in
instructions; shared retrieval guidance and the report protocol still apply.

Investigation implicitly prepares or reuses the lane's immutable SQLite snapshot.
Both AoE sessions must be idle or waiting at launch, and both role evidence sources
must be available (partial sources with recorded gaps are allowed). Collection
prints the snapshot time, cutoff, size and gaps. Reuse does not refresh native
evidence: run `lane evidence --force` before investigating newer activity. Work
resuming after launch does not change the fixed snapshot being analyzed.

A separate Codex analyst receives the first bounded overview page and the
progressive evidence CLI. It chooses which events/bodies to inspect and derives
patterns itself. There is no whole-projection token gate, block-selection mode,
query audit trail or session token budget. The harness manages its context;
per-response token estimates help it page evidence. Codex is also used for an
OpenCode-authored lane. The model defaults to the lane's Codex author/reviewer
model when present; `--analyst-model <model>` overrides it. The analyst incurs
model cost.

The analyst runs from a private temporary directory with `workspace-write`,
no added writable roots, no writable shared temporary directories, no network
access for its tools, and no approval escalation. Repository/cache access is
read-only. User configuration and exec rules are not loaded for this constrained
session. A lifetime reader lease protects the snapshot; query commands borrow
it without writing to the cache. The session is persisted by Codex so a correction
can resume it; TARS does not store analyst transcripts or reports.

The analyst writes `answer.json`, following the generic version-one shape in
`lib/investigation-report.mjs`: snapshot/question identity, whole-lane or partial
scope, Markdown summary, findings with block IDs and Markdown analysis, material
limitations, conclusion and a citation registry. Inline `{{cite:<id>}}` markers
place citations beside the claims they support. Registry entries identify either
an indexed event or a repository commit/path with an optional line. Short relevant
excerpts are allowed. The analyst self-validates using
`lane investigate validate-report --file <answer.json> --context <assigned-context.json>`.
This command opens no lane registry. TARS validates the file again after completion,
checks schema and references (repository commit/path in local Git, not line meaning
or diagnosis), and requests at most one correction in the same session.

TARS deterministically renders valid reports as Markdown. `--output <markdown-path>`
exports the report; otherwise it is printed only. Existing files are never
overwritten. Snapshot time and cutoff appear in the report. The temporary answer,
context and process-output files are removed, and the lease is released on success,
validation/process failure, timeout or handled interruption. SIGKILL cannot run
cleanup; the next cache mutation reclaims its dead owner's lease, while the OS may
retain the private temporary run directory until normal temporary-file cleanup.

### Native capture locations and launch troubleshooting

Codex's optional rollout trace bundles are written under
`$CODEX_HOME/tars/rollout-traces/lane-<lane-id>/<role>/`. When `CODEX_HOME` is
unset, the location is `~/.codex/tars/rollout-traces/...`. This is a TARS
convention inside Codex's home; Codex itself does not define a default root for
optional trace bundles. Each Codex role has a separate directory, apart from
ordinary Codex session rollouts under `$CODEX_HOME/sessions/`. OpenCode evidence
continues to live in OpenCode's native session store. TARS does not copy these
native records into TARS state or prune trace bundles automatically; operators
can remove a lane directory when its evidence is no longer needed.

For a capture-enabled OpenCode role, TARS starts a loopback OpenCode server in
the lane worktree, creates the native session through its API, and launches AoE
with an attach command for that exact session ID. The ID, server port, and
process ID are stored only in the active lane row. `tars lane recover` starts a
stopped server on the recorded port before restarting the AoE session.
`tars lane resume --create-sessions` creates a new native session for a
missing role and retains its earlier IDs in the active lane row. Closing the
lane stops these loopback servers; OpenCode's native session history remains in
OpenCode's own store.

AoE may require a one-time acknowledgement of its agent hook paths before it
launches Codex or OpenCode sessions on this machine. If lane start reports that
the paths have not been acknowledged, open the AoE TUI, create a temporary
Codex or OpenCode session, review and accept the hook acknowledgement dialog,
then remove the temporary session and retry.

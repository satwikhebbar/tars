import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { orderEvidenceEvents, storeEventFields } from "./investigation-fields.mjs"

export const SNAPSHOT_VERSION = 3
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CHUNK_BYTES = 8192

export function evidenceCacheRoot(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agent-review-loop", "evidence-indexes")
}

/** Immutable, disposable evidence caches; native stores are never modified. */
export class EvidenceSnapshots {
  constructor({ root = evidenceCacheRoot(), now = () => new Date() } = {}) {
    this.root = root
    this.now = now
  }

  async list() {
    const snapshots = []
    for (const lane of await directories(this.root)) {
      for (const id of await directories(join(this.root, lane))) {
        if (id.startsWith(".staging-")) continue
        const directory = join(this.root, lane, id)
        try {
          const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
          if (manifest.snapshotId !== id || laneKey(manifest.laneId) !== lane ||
              !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(manifest.expiresAt))) continue
          const size = (await stat(join(directory, "evidence.sqlite"))).size
          snapshots.push({ ...manifest, directory, sizeBytes: size,
            usable: manifest.indexVersion === SNAPSHOT_VERSION && Date.parse(manifest.expiresAt) > +this.now() })
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
        }
      }
    }
    return snapshots.sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0) ||
      b.createdAt.localeCompare(a.createdAt) || b.snapshotId.localeCompare(a.snapshotId))
  }

  async prepare(options) {
    return this.mutate(() => this.prepareLocked(options))
  }

  async prepareLocked({ laneId, force = false, collect }) {
    if (typeof laneId !== "string" || !laneId) throw new Error("A lane identity is required.")
    await this.pruneLocked()
    if (!force) {
      const existing = (await this.list()).find((item) => item.laneId === laneId && item.usable)
      if (existing) return { ...existing, reused: true }
    }
    const snapshotId = randomUUID()
    const generation = Math.max(0, ...(await this.list()).filter((item) => item.laneId === laneId).map((item) => item.generation ?? 0)) + 1
    const parent = join(this.root, laneKey(laneId))
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await chmod(parent, 0o700)
    const staging = join(parent, `.staging-${snapshotId}`)
    await mkdir(staging, { mode: 0o700 })
    let db
    try {
      const evidence = await collect()
      const created = this.now()
      const path = join(staging, "evidence.sqlite")
      db = new DatabaseSync(path)
      db.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE sources (source_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, native_json TEXT NOT NULL);
        CREATE TABLE blocks (block_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
        CREATE TABLE events (event_id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(source_id),
          block_id TEXT REFERENCES blocks(block_id), role TEXT NOT NULL, event_type TEXT NOT NULL,
          native_position INTEGER, time_ms REAL, metadata_json TEXT NOT NULL, extra_json TEXT NOT NULL);
        CREATE INDEX events_block ON events(block_id, native_position);
        CREATE INDEX events_role_type ON events(role, event_type, time_ms);
        CREATE TABLE event_fields (event_id TEXT NOT NULL REFERENCES events(event_id), field_id TEXT NOT NULL,
          parent_id TEXT, ordinal INTEGER NOT NULL, key_json TEXT NOT NULL, kind TEXT NOT NULL,
          value_json TEXT, text_bytes INTEGER, line_count INTEGER, field_path TEXT NOT NULL,
          PRIMARY KEY(event_id, field_id));
        CREATE INDEX fields_parent ON event_fields(event_id, parent_id, ordinal);
        CREATE INDEX fields_path ON event_fields(event_id, field_path);
        CREATE TABLE event_facts (event_id TEXT PRIMARY KEY REFERENCES events(event_id), timeline_position INTEGER NOT NULL,
          tool_name TEXT, action TEXT, query TEXT, targets_json TEXT NOT NULL, visible_output_bytes INTEGER, message_id TEXT);
        CREATE INDEX facts_order ON event_facts(timeline_position);
        CREATE INDEX facts_action ON event_facts(action, tool_name);
        CREATE TABLE event_content_chunks (content_id TEXT NOT NULL, chunk_no INTEGER NOT NULL,
          text TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(content_id, chunk_no));
      `)
      db.exec("PRAGMA foreign_keys = ON; BEGIN")
      for (const block of evidence.blocks ?? []) db.prepare("INSERT INTO blocks VALUES (?, ?)").run(block.id, JSON.stringify(block))
      const store = createContentStore(db)
      for (const source of evidence.sources) {
        db.prepare("INSERT INTO sources VALUES (?, ?, ?)").run(source.id,
          JSON.stringify(source.metadata), JSON.stringify(store.pack(source.native)))
      }
      for (const [timelinePosition, event] of orderEvidenceEvents(evidence.events, evidence.sources).entries()) {
        const { extra = {}, ...metadata } = event
        db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event.id,
          event.sourceId ?? null, event.blockId ?? null, event.role, event.type,
          event.position ?? null, event.time ?? null, JSON.stringify(store.pack(metadata)), JSON.stringify(store.pack(extra)))
        const action = event.attributes?.normalizedAction
        db.prepare("INSERT INTO event_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(event.id, timelinePosition,
          event.attributes?.name ?? null, action?.kind ?? null, action?.query ?? null,
          JSON.stringify(action?.targets ?? []), event.attributes?.visibleOutputBytes ?? null, event.pointer?.messageId ?? null)
        storeEventFields(db, event.id, JSON.parse(JSON.stringify({ ...metadata, extra })), store.pack)
      }
      db.exec("COMMIT")
      db.close(); db = null
      await chmod(path, 0o600)
      const manifest = { indexVersion: SNAPSHOT_VERSION, snapshotId, laneId, generation,
        createdAt: created.toISOString(), expiresAt: new Date(+created + RETENTION_MS).toISOString(),
        asOf: evidence.asOf, cutoff: evidence.cutoff ?? evidence.asOf,
        sourceCount: evidence.sources.length, eventCount: evidence.events.length,
        sources: evidence.sources.map((source) => ({ sourceId: source.id, ...source.metadata })),
        gaps: evidence.gaps ?? [], coverage: evidence.coverage ?? {}, sizeBytes: (await stat(path)).size }
      await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
      const directory = join(parent, snapshotId)
      await rename(staging, directory)
      return { ...manifest, directory, usable: true, reused: false }
    } finally {
      db?.close()
      await rm(staging, { recursive: true, force: true })
    }
  }

  async remove(id) { return this.mutate(() => this.removeLocked(id)) }

  async removeLocked(id) {
    const snapshot = (await this.list()).find((item) => item.snapshotId === id)
    if (!snapshot) throw new Error(`Unknown evidence snapshot ${id}.`)
    if (await this.hasLeases(snapshot)) throw new Error(`Evidence snapshot ${id} is in use.`)
    await rm(snapshot.directory, { recursive: true })
  }

  async prune() { return this.mutate(() => this.pruneLocked()) }

  async pruneLocked() {
    const removed = []
    for (const snapshot of await this.list()) {
      if (Date.parse(snapshot.expiresAt) > +this.now()) continue
      if (await this.hasLeases(snapshot)) continue
      await this.removeLocked(snapshot.snapshotId)
      removed.push(snapshot.snapshotId)
    }
    return removed
  }

  /** Acquire under the same lock as deletion; callers release after closing readers. */
  async lease(id) {
    return this.mutate(async () => {
      const snapshot = (await this.list()).find((item) => item.snapshotId === id && item.usable)
      if (!snapshot) throw new Error(`Unknown or expired evidence snapshot ${id}.`)
      const leaseId = randomUUID()
      const directory = join(snapshot.directory, "leases", leaseId)
      const pending = join(snapshot.directory, `.lease-pending-${leaseId}`)
      await mkdir(join(snapshot.directory, "leases"), { recursive: true, mode: 0o700 })
      try {
        await mkdir(pending, { mode: 0o700 })
        await writeFile(join(pending, "owner.json"), JSON.stringify(owner()), { mode: 0o600 })
        await rename(pending, directory)
      } finally { await rm(pending, { recursive: true, force: true }) }
      let released = false
      return { snapshot, leaseId, release: async () => {
        if (released) return
        await this.mutate(() => rm(directory, { recursive: true, force: true }))
        released = true
      } }
    })
  }

  async hasLeases(snapshot) {
    const parent = join(snapshot.directory, "leases")
    for (const id of await directories(parent)) {
      const directory = join(parent, id)
      if (await deadOwner(directory)) await rm(directory, { recursive: true, force: true })
    }
    return (await directories(parent)).length > 0
  }

  /** All publishers, lease changes and removals share one local filesystem lock. */
  async mutate(action) {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    // SQLite releases this advisory write transaction even after SIGKILL.
    // Evidence itself stays in separate immutable databases.
    const lockPath = join(this.root, "cache-lock.sqlite")
    const lock = new DatabaseSync(lockPath)
    await chmod(lockPath, 0o600)
    const deadline = Date.now() + 10000
    try {
      for (;;) {
        try { lock.exec("BEGIN IMMEDIATE"); break }
        catch (error) {
          if (!/locked|busy/i.test(error.message)) throw error
          if (Date.now() >= deadline) throw new Error("Evidence cache is busy; retry after the current collection finishes.")
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      try {
        // No publisher can still own staging while this lock is held.
        for (const lane of await directories(this.root)) {
          if (!/^[a-f0-9]{64}$/.test(lane)) continue
          for (const id of await directories(join(this.root, lane))) {
            const directory = join(this.root, lane, id)
            if (id.startsWith(".staging-")) await rm(directory, { recursive: true, force: true })
            else for (const entry of await directories(directory)) {
              if (entry.startsWith(".lease-pending-")) await rm(join(directory, entry), { recursive: true, force: true })
            }
          }
        }
        return await action()
      } finally { lock.exec("ROLLBACK") }
    } finally { lock.close() }
  }

}

/** Read-only reader. Reconstructing native data is for fidelity checks, not analyst paging. */
export function openEvidenceSnapshot(directory) {
  const db = new DatabaseSync(join(directory, "evidence.sqlite"), { readOnly: true })
  const unpack = (value) => {
    if (Array.isArray(value)) return value.map(unpack)
    if (!value || typeof value !== "object") return value
    if (value.$tarsContent && Object.keys(value).length === 1) {
      const rows = db.prepare("SELECT text FROM event_content_chunks WHERE content_id = ? ORDER BY chunk_no").all(value.$tarsContent)
      if (!rows.length) throw new Error(`Missing content ${value.$tarsContent}.`)
      return rows.map((row) => JSON.parse(row.text)).join("")
    }
    if (value.$tarsLiteral && Object.keys(value).length === 1) return Object.fromEntries(value.$tarsLiteral.map(([key, item]) => [key, unpack(item)]))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]))
  }
  return { database: db, close: () => db.close(),
    native: (sourceId) => {
      const row = db.prepare("SELECT native_json FROM sources WHERE source_id = ?").get(sourceId)
      if (!row) throw new Error(`Unknown evidence source ${sourceId}.`)
      return unpack(JSON.parse(row.native_json))
    },
    unpack,
  }
}

function createContentStore(db) {
  const known = new Set()
  const insert = db.prepare("INSERT INTO event_content_chunks VALUES (?, ?, ?, ?)")
  const pack = (value) => {
    if (typeof value === "string" && Buffer.byteLength(value) > 1024) {
      const id = createHash("sha256").update(JSON.stringify(value)).digest("hex")
      if (!known.has(id)) {
        let chunk = "", bytes = 0, index = 0
        for (const character of value) {
          const length = Buffer.byteLength(character)
          if (bytes + length > CHUNK_BYTES) { insert.run(id, index++, JSON.stringify(chunk), bytes); chunk = ""; bytes = 0 }
          chunk += character; bytes += length
        }
        if (chunk) insert.run(id, index, JSON.stringify(chunk), bytes)
        known.add(id)
      }
      return { $tarsContent: id }
    }
    if (Array.isArray(value)) return value.map(pack)
    if (!value || typeof value !== "object") return value
    const entries = Object.entries(value).map(([key, item]) => [key, pack(item)])
    // Escape native objects resembling our internal reference syntax.
    if (entries.some(([key]) => key === "$tarsContent" || key === "$tarsLiteral")) return { $tarsLiteral: entries }
    return Object.fromEntries(entries)
  }
  return { pack }
}

function laneKey(id) { return createHash("sha256").update(id).digest("hex") }
async function directories(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name) }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
}

function owner() { return { pid: process.pid, host: hostname() } }
async function deadOwner(directory) {
  try {
    const record = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"))
    if (record.host !== hostname() || !Number.isInteger(record.pid) || record.pid <= 0) return false
    try { process.kill(record.pid, 0); return false }
    catch (error) { return error.code === "ESRCH" }
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return false
    }
    throw error
  }
}

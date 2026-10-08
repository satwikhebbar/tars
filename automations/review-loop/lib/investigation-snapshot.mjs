import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const SNAPSHOT_VERSION = 1
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

  async prepare({ laneId, force = false, collect }) {
    if (typeof laneId !== "string" || !laneId) throw new Error("A lane identity is required.")
    await this.prune()
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
      for (const event of evidence.events) {
        const { extra = {}, ...metadata } = event
        db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event.id,
          event.sourceId ?? null, event.blockId ?? null, event.role, event.type,
          event.position ?? null, event.time ?? null, JSON.stringify(store.pack(metadata)), JSON.stringify(store.pack(extra)))
      }
      db.exec("COMMIT")
      db.close(); db = null
      await chmod(path, 0o600)
      const manifest = { indexVersion: SNAPSHOT_VERSION, snapshotId, laneId, generation,
        createdAt: created.toISOString(), expiresAt: new Date(+created + RETENTION_MS).toISOString(),
        asOf: evidence.asOf, cutoff: evidence.cutoff ?? evidence.asOf,
        sourceCount: evidence.sources.length, eventCount: evidence.events.length,
        sources: evidence.sources.map((source) => ({ sourceId: source.id, ...source.metadata })),
        gaps: evidence.gaps ?? [], sizeBytes: (await stat(path)).size }
      await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
      const directory = join(parent, snapshotId)
      await rename(staging, directory)
      return { ...manifest, directory, usable: true, reused: false }
    } finally {
      db?.close()
      await rm(staging, { recursive: true, force: true })
    }
  }

  async remove(id) {
    const snapshot = (await this.list()).find((item) => item.snapshotId === id)
    if (!snapshot) throw new Error(`Unknown evidence snapshot ${id}.`)
    if ((await directories(join(snapshot.directory, "leases"))).length) throw new Error(`Evidence snapshot ${id} is in use.`)
    await rm(snapshot.directory, { recursive: true })
  }

  async prune() {
    const removed = []
    for (const snapshot of await this.list()) {
      if (Date.parse(snapshot.expiresAt) > +this.now()) continue
      if ((await directories(join(snapshot.directory, "leases"))).length) continue
      await this.remove(snapshot.snapshotId)
      removed.push(snapshot.snapshotId)
    }
    return removed
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

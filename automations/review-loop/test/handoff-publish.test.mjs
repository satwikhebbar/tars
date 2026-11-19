import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { publishHandoff, validateHandoffCommit } from "../lib/handoff-publish.mjs"
import { readHandoff } from "../lib/handoff.mjs"
import { ReviewLoopCoordinator } from "../lib/coordinator.mjs"
import { StateStore } from "../lib/state.mjs"

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tars-publish-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => exec("git", ["-C", root, ...args])
  await git("init")
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "test")
  const sha = (await git("rev-parse", "HEAD")).stdout.trim()
  const draft = join(root, "draft.md")
  await writeFile(draft, "---\nid: implementation-1\ntype: implementation-response\ncreated_by: author\nworkflow_id: test\nround: 1\nhead_commit: made-up\nhead_commit: wrong-again\n---\n\n## Verification\nTests passed.\n")
  return { root, draft, sha, git }
}

test("publishing inserts exact Git HEAD, preserves body and refuses replacement", async (t) => {
  const { root, draft, sha } = await fixture(t)
  const result = await publishHandoff({ draftPath: draft, worktreePath: root })
  const contents = await readFile(result.path, "utf8")
  assert.equal((await readHandoff(result.path)).metadata.head_commit, sha)
  assert.equal(contents.match(/head_commit:/g).length, 1)
  assert.ok(contents.endsWith("\n## Verification\nTests passed.\n"))
  await assert.rejects(publishHandoff({ draftPath: draft, worktreePath: root }), { code: "EEXIST" })
  assert.deepEqual(await readdir(join(root, ".agent-handoff", "inbox")), ["implementation-1.md"])
})

test("publishing without a supplied SHA works and concurrent publication has one winner", async (t) => {
  const { root, draft, sha } = await fixture(t)
  await writeFile(draft, (await readFile(draft, "utf8")).replace(/^head_commit:.*\n/gm, ""))
  const results = await Promise.allSettled([publishHandoff({ draftPath: draft, worktreePath: root }), publishHandoff({ draftPath: draft, worktreePath: root })])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal((await readHandoff(join(root, ".agent-handoff/inbox/implementation-1.md"))).metadata.head_commit, sha)
})

test("missing HEAD or invalid protocol never publishes a partial handoff", async (t) => {
  const { root, draft } = await fixture(t)
  await writeFile(draft, (await readFile(draft, "utf8")).replace("round: 1", "round: 0"))
  await assert.rejects(publishHandoff({ draftPath: draft, worktreePath: root }), /positive integer round/)
  const empty = await mkdtemp(join(tmpdir(), "tars-unborn-"))
  t.after(() => rm(empty, { recursive: true, force: true }))
  await exec("git", ["-C", empty, "init"])
  await assert.rejects(publishHandoff({ draftPath: draft, worktreePath: empty }))
  await assert.rejects(readdir(join(empty, ".agent-handoff/inbox")), { code: "ENOENT" })
})

test("commit validation rejects fabricated SHAs, prefixes, refs and non-commit objects", async (t) => {
  const { root, sha, git, draft } = await fixture(t)
  const handoff = (head_commit) => ({ metadata: { type: "implementation-response", head_commit } })
  assert.deepEqual(await validateHandoffCommit(handoff(sha), root), [])
  const blob = (await git("hash-object", "-w", draft)).stdout.trim()
  for (const invalid of [sha.slice(0, 7), "HEAD", "0".repeat(40), blob]) {
    assert.equal((await validateHandoffCommit(handoff(invalid), root)).length, 1)
  }
})

test("dispatcher rejects a nonexistent SHA before notifying reviewer, then accepts tool-published correction", async (t) => {
  const { root, draft, sha } = await fixture(t)
  const published = await publishHandoff({ draftPath: draft, worktreePath: root })
  await writeFile(published.path, (await readFile(published.path, "utf8")).replace(sha, "0".repeat(40)))
  const state = new StateStore(join(root, "state.sqlite"))
  await state.open()
  t.after(() => state.close())
  state.saveLane({ worktreePath: root, authorSessionId: "author", reviewerSessionId: "reviewer", state: "implementing", maxRounds: 5 })
  const sent = []
  const aoe = { runningSessions: async () => [{ session: "reviewer", state: "idle" }], send: async (...args) => sent.push(args) }
  const coordinator = new ReviewLoopCoordinator({ aoe, state })
  const blocked = await coordinator.processAll()
  assert.match(blocked[0].action, /not an available commit/)
  assert.equal(sent.length, 0)
  assert.equal(state.lane(root).state, "invalid_handoff")
  await rm(published.path)
  await publishHandoff({ draftPath: draft, worktreePath: root })
  await coordinator.processAll()
  assert.equal(sent.length, 1)
  assert.ok(sent[0][1].includes(sha))
})

test("CLI publish runs without shared state and inserts Git HEAD", async (t) => {
  const { root, draft, sha } = await fixture(t)
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  const result = await exec(process.execPath, [cli, "handoff", "publish", "--file", draft, "--worktree", root, "--state", "/cannot-write/state.sqlite"])
  assert.ok(result.stdout.includes(sha))
})

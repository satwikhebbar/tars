import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import { StateStore } from "../lib/state.mjs"

const execFileAsync = promisify(execFile)
const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url))

for (const args of [["--help"], ["-h"], ["handoff", "--help"]]) {
  test(`prints usage for ${args.join(" ")}`, async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args])
    assert.equal(stderr, "")
    assert.match(stdout, /^Usage:/)
    assert.match(stdout, /handoff validate --path <handoff-file>/)
    assert.match(stdout, /lane recover --worktree <path> --role author\|reviewer/)
    assert.match(stdout, /lane evidence \(--worktree <path> \| --issue <number>\)/)
    assert.match(stdout, /tars lane set-max-rounds --worktree <path> \[--max-rounds <number> \| --review-budget <number>\] \(at least one required\) \[--resume\]/)
  })
}

test("lane evidence accepts issue and worktree selectors and prints a coverage gap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-cli-evidence-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  const worktree = join(root, "issue-75-evidence-test")
  const statePath = join(root, "state.sqlite")
  await mkdir(bin)
  await mkdir(worktree)
  const canonicalWorktree = await realpath(worktree)
  for (const [command, body] of [
    ["aoe", `console.log(JSON.stringify([{session:"author-aoe",state:"idle"},{session:"reviewer-aoe",state:"waiting"}]))`],
    ["opencode", `console.log(JSON.stringify({info:{id:"ses_123"},messages:[]}))`],
  ]) {
    const executable = join(bin, command)
    await writeFile(executable, `#!${process.execPath}\n${body}\n`)
    await chmod(executable, 0o700)
  }
  const state = new StateStore(statePath)
  await state.open()
  state.saveLane({
    worktreePath: canonicalWorktree, authorSessionId: "author-aoe", reviewerSessionId: "reviewer-aoe",
    state: "watching", maxRounds: 5, investigationCapture: "capture",
    authorHarness: "opencode", reviewerHarness: "codex",
    authorEvidence: { status: "available", harness: "opencode", nativeSessionId: "ses_123" },
    reviewerEvidence: { status: "unavailable", harness: "codex", reason: "trace unavailable" },
  })
  state.close()
  const run = (args) => execFileAsync(process.execPath, [cliPath, "lane", "evidence", ...args, "--state", statePath], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  for (const selector of [["--issue", "75"], ["--worktree", worktree]]) {
    const { stdout, stderr } = await run(selector)
    assert.equal(stderr, "")
    assert.match(stdout, /author: available \(opencode\); .*session ses_123/)
    assert.match(stdout, /reviewer: unavailable \(codex\): trace unavailable/)
    assert.match(stdout, /Source inventory only/)
  }
  await assert.rejects(run(["--issue", "75", "--worktree", worktree]), /Specify either --worktree.*or --issue/)
  await assert.rejects(run([]), /lane evidence requires --worktree.*or --issue/)
})

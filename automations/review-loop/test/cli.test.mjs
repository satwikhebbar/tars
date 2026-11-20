import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import { StateStore } from "../lib/state.mjs"

const execFileAsync = promisify(execFile)
const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url))

test("plain lane resume unblocks and dispatches while lane diagnose is read-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-cli-resume-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worktree = await realpath(root)
  const bin = join(root, "bin")
  const sent = join(root, "sent")
  const statePath = join(root, "state.sqlite")
  await mkdir(bin)
  await mkdir(join(root, ".agent-handoff", "inbox"), { recursive: true })
  await writeFile(join(root, ".agent-handoff", "inbox", "retry.md"), `---\nid: retry\ntype: code-review\nstatus: ready\ncreated_by: reviewer\nworkflow_id: fix\nround: 2\niteration: 1\noutcome: changes_requested\n---\nFix the finding.\n`)
  await writeFile(join(bin, "aoe"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst command=process.argv[2];\nif(command==='list') console.log(JSON.stringify([{id:'author',path:${JSON.stringify(worktree)},tool:'codex'},{id:'reviewer',path:${JSON.stringify(worktree)},tool:'codex'}]));\nelse if(command==='ps') console.log(JSON.stringify([{session:'author',state:'idle'},{session:'reviewer',state:'idle'}]));\nelse if(command==='send') appendFileSync(${JSON.stringify(sent)},'sent\\n');\n`)
  await chmod(join(bin, "aoe"), 0o700)
  const state = new StateStore(statePath)
  await state.open()
  state.saveLane({ worktreePath: worktree, authorSessionId: "author", reviewerSessionId: "reviewer", authorTool: "codex", authorHarness: "codex", reviewerTool: "codex", reviewerHarness: "codex", state: "blocked", maxRounds: 20, reviewBudget: 20, reviewBudgetConsumed: 6 })
  state.close()
  const run = command => execFileAsync(process.execPath, [cliPath, "lane", command, "--worktree", worktree, "--state", statePath], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  assert.match((await run("diagnose")).stdout, /Verdict:  blocked/)
  await assert.rejects(readFile(sent), { code: "ENOENT" })
  assert.match((await run("resume")).stdout, /dispatched:/)
  await run("resume")
  assert.equal(await readFile(sent, "utf8"), "sent\n")
})

for (const args of [["--help"], ["-h"], ["handoff", "--help"]]) {
  test(`prints usage for ${args.join(" ")}`, async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args])
    assert.equal(stderr, "")
    assert.match(stdout, /^Usage:/)
    assert.match(stdout, /handoff validate --path <handoff-file>/)
    assert.match(stdout, /lane recover --worktree <path> --role author\|reviewer/)
    assert.match(stdout, /lane investigate validate-report --file/)
    assert.match(stdout, /lane evidence \(--worktree <path> \| --issue <number>\)/)
    assert.match(stdout, /tars lane set-max-rounds \(--worktree <path> \| --issue <number>\) \[--max-rounds <number> \| --review-budget <number>\] \(at least one required\) \[--resume\]/)
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
    ["opencode", `console.log(JSON.stringify({info:{id:"ses_123",directory:"${worktree}"},messages:[{info:{id:"msg_1",time:{created:100}},parts:[{id:"p1",sessionID:"ses_123",messageID:"msg_1",type:"tool",tool:"read",state:{status:"completed",input:{filePath:"${worktree}/a.ts"},metadata:{display:{type:"file",path:"${worktree}/a.ts",text:"content",lineStart:1,lineEnd:1,totalLines:1}}}},{id:"p2",sessionID:"ses_123",messageID:"msg_1",type:"tool",tool:"bash",state:{status:"completed",input:{command:"cat a.ts && cat b.ts"},output:"content",metadata:{exit:0}}}]}]}))`],
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: join(root, "cache") },
  })
  for (const selector of [["--issue", "75"], ["--worktree", worktree]]) {
    const { stdout, stderr } = await run(selector)
    assert.doesNotMatch(stderr, /Error:/)
    assert.match(stdout, /author: available \(opencode\); .*session ses_123/)
    assert.match(stdout, /reviewer: unavailable \(codex\): trace unavailable/)
    assert.match(stdout, /Evidence snapshot (created|reused)/)
  }
  const { stdout: indexed } = await run(["--issue", "75", "--force"])
  assert.match(indexed, /Evidence snapshot created/)
  assert.match(indexed, /SQLite: .*evidence.sqlite \(\d+ bytes; \d+ events\)/)
  await assert.rejects(run(["--issue", "75", "--index"]), /Unknown option '--index'/)
  await assert.rejects(run(["--issue", "75", "--worktree", worktree]), /Specify either --worktree.*or --issue/)
  await assert.rejects(run([]), /lane evidence requires --worktree.*or --issue/)
})

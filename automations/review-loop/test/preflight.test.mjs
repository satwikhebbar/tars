import assert from "node:assert/strict"
import test from "node:test"
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { preflightCommand, prepareHarnessPreflight } from "../lib/preflight.mjs"

const harness = (key) => ({ key, displayName: key })

test("builds a bounded Codex preflight command", () => {
  assert.deepEqual(
    preflightCommand(harness("codex"), "/tmp/lane", "classify this", "gpt-5.6-luna"),
    ["codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--model", "gpt-5.6-luna", "classify this"]],
  )
})

test("builds a non-persistent plan-mode Claude preflight command", () => {
  assert.deepEqual(
    preflightCommand(harness("claude"), "/tmp/lane", "classify this", "claude-sonnet"),
    ["claude", ["--print", "--no-session-persistence", "--permission-mode", "plan", "--model", "claude-sonnet", "classify this"]],
  )
})

test("passes the classifier model to isolated OpenCode preflight", () => {
  assert.deepEqual(
    preflightCommand(harness("opencode"), "/tmp/lane", "classify this", "provider/model"),
    ["opencode", ["run", "--pure", "--dir", "/tmp/lane", "--model", "provider/model", "classify this"]],
  )
})

test("validates and runs OpenCode classification in the same pure temporary context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tars-classifier-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, "calls.jsonl")
  const command = join(directory, "opencode")
  await writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd()}) + "\\n");
process.stdout.write(args[0] === "models" ? "global/classifier\\n" : "classified");
`)
  await chmod(command, 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = directory
  let context
  try {
    context = await prepareHarnessPreflight({ key: "opencode", launchArgs: ["--pure=false", "--agent", "project-agent"] }, { model: "global/classifier" })
    assert.equal(await context.run("classify"), "classified")
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    assert.deepEqual(calls[0].args, ["models", "--pure"])
    assert.deepEqual(calls[1].args, ["run", "--pure", "--dir", calls[0].cwd, "--model", "global/classifier", "classify"])
    assert.equal(calls[1].cwd, calls[0].cwd)
    assert.notEqual(calls[0].cwd, process.cwd())
    await context.dispose()
    await assert.rejects(access(calls[0].cwd), /ENOENT/)
    await assert.rejects(prepareHarnessPreflight(harness("opencode"), { model: "project/model" }), /classifier OpenCode model.*Provider 'project' is unavailable/)
    const rejected = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1))
    await assert.rejects(access(rejected.cwd), /ENOENT/)
  } finally {
    process.env.PATH = previousPath
    await context?.dispose()
  }
})

test("omits model flags when no author model is configured", () => {
  assert.deepEqual(
    preflightCommand(harness("codex"), "/tmp/lane", "classify this"),
    ["codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "classify this"]],
  )
})

test("closes classifier stdin so a piped Codex process can finish", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tars-classifier-eof-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = join(directory, "codex")
  await writeFile(command, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('finished after EOF'));\n`)
  await chmod(command, 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = directory
  let context
  try {
    context = await prepareHarnessPreflight(harness("codex"), { validateModels: async () => {} })
    assert.equal(await context.run("classify"), "finished after EOF")
  } finally { process.env.PATH = previousPath; await context?.dispose() }
})

test("never treats the failed command's echoed prompt as a classifier response", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tars-classifier-error-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = join(directory, "codex")
  await writeFile(command, `#!${process.execPath}\nprocess.stderr.write('service unavailable'); process.exit(1);\n`)
  await chmod(command, 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = directory
  let context
  try {
    context = await prepareHarnessPreflight(harness("codex"), { validateModels: async () => {} })
    await assert.rejects(context.run('Classify this\nTARS_LANE_PREFLIGHT={"branch":"example"}'), (error) => {
      assert.match(error.message, /command failed.*service unavailable/)
      assert.ok(!error.message.includes("TARS_LANE_PREFLIGHT"))
      return true
    })
    await writeFile(command, `#!${process.execPath}\nprocess.stderr.write('TARS_LANE_PREFLIGHT={"branch":"issue/1-fix","worktree_name":"issue-1-fix","planning":"required"}'); process.exit(1);\n`)
    assert.match(await context.run("classify"), /^TARS_LANE_PREFLIGHT=/)
  } finally { process.env.PATH = previousPath; await context?.dispose() }
})

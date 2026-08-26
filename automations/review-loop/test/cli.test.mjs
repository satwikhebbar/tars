import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

const execFileAsync = promisify(execFile)
const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url))

for (const args of [["--help"], ["-h"], ["handoff", "--help"]]) {
  test(`prints usage for ${args.join(" ")}`, async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args])
    assert.equal(stderr, "")
    assert.match(stdout, /^Usage:/)
    assert.match(stdout, /handoff validate --path <handoff-file>/)
    assert.match(stdout, /lane recover --worktree <path> --role author\|reviewer/)
    assert.match(stdout, /lane set-max-rounds --worktree <path> --max-rounds <number>/)
  })
}

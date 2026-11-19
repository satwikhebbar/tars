import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { readIssue } from "../lib/github.mjs"

const issue = { number: 99, state: "OPEN", title: "Reported costs", body: "Requirements", labels: [{ name: "bug" }], url: "https://github.com/owner/repo/issues/99" }
const lookup = (result) => ({ exec: async () => ({ stdout: JSON.stringify(result) }) })

test("reads an issue and normalizes labels, including enterprise URLs", async () => {
  for (const host of ["github.com", "github.example.com"]) {
    const result = { ...issue, url: `https://${host}/owner/repo/issues/99` }
    assert.deepEqual(await readIssue("/repo", 99, lookup(result)), { ...result, labels: ["bug"] })
  }
})

test("rejects PRs returned successfully by gh issue view", async () => {
  await assert.rejects(readIssue("/repo", 100, lookup({ ...issue, number: 100, url: "https://github.com/owner/repo/pull/100" })), /#100 is a pull request.*not an issue/)
})

test("rejects closed issues and preserves missing-issue lookup failures", async () => {
  await assert.rejects(readIssue("/repo", 99, lookup({ ...issue, state: "CLOSED" })), /issue #99 is closed/)
  await assert.rejects(readIssue("/repo", 99, lookup({ ...issue, state: undefined })), /invalid issue state/)
  const missing = new Error("Could not resolve to an Issue with the number of 99")
  await assert.rejects(readIssue("/repo", 99, { exec: async () => { throw missing } }), (error) => error === missing)
})

test("fails closed on missing URLs, non-issue URLs, or mismatched issue numbers", async () => {
  for (const result of [{ ...issue, url: undefined }, { ...issue, url: "invalid" }, { ...issue, url: "https://github.com/owner/repo" }, { ...issue, number: 100 }, { ...issue, url: "https://github.com/owner/repo/issues/100" }]) {
    await assert.rejects(readIssue("/repo", 99, lookup(result)), /Cannot verify GitHub issue/)
  }
})

test("lane start rejects a PR before creating sessions or running a classifier, even with custom names/prompts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tars-github-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const gh = join(directory, "gh")
  await writeFile(gh, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ ...issue, number: 100, url: "https://github.com/owner/repo/pull/100" }))});\n`)
  await chmod(gh, 0o700)
  const aoe = join(directory, "aoe")
  await writeFile(aoe, `#!${process.execPath}\nif (process.argv.slice(2).join(" ") !== "agents") throw Error("Unexpected AoE mutation");\nconsole.log("✓ codex installed");\n`)
  await chmod(aoe, 0o700)
  const config = join(directory, "config.json")
  await writeFile(config, JSON.stringify({ defaults: { author: "codex", reviewer: "codex" } }))
  for (const flags of [[], ["--planning", "never", "--branch", "custom", "--worktree-name", "custom", "--prompt", "Do work"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, [new URL("../cli.mjs", import.meta.url).pathname, "lane", "start", "--repo", directory, "--issue", "100", "--config", config, "--state", join(directory, "state.sqlite"), ...flags], { env: { ...process.env, PATH: directory } }), (error) => {
      assert.match(error.stderr, /#100 is a pull request.*no lane was created/)
      assert.doesNotMatch(error.stderr, /lane preflight:|started:|aoe|ENOENT/)
      return true
    })
  }
})

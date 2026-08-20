import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { assertHarnessAvailable, loadHarnessConfig, parseInstalledAoeTools, provisionHarnessSkills, provisionWorktreeHarnessRequirements, resolveHarness, saveHarnessConfig } from "../lib/harnesses.mjs"

const ROOT = new URL("../../..", import.meta.url).pathname

test("normalizes defaults and resolves custom AoE-backed harnesses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tars-config-"))
  const path = join(directory, "config.json")
  assert.deepEqual(await loadHarnessConfig(path), { defaults: { author: "opencode", reviewer: "codex" }, harnesses: {} })
  await saveHarnessConfig({ defaults: { author: "claude", reviewer: "cursor" }, harnesses: { pi: { tool: "pi", displayName: "Pi" } } }, path)
  const config = await loadHarnessConfig(path)
  assert.equal(resolveHarness(config, "pi").tool, "pi")
  assert.equal(resolveHarness(config, "claude").displayName, "Claude Code")
  assert.deepEqual(resolveHarness(config, "codex").launchArgs, ["--approve-for-me"])
  assert.throws(() => resolveHarness(config, "missing"), /Unknown TARS harness/)
})

test("parses AoE's checkmark inventory and rejects unavailable selected harnesses", async () => {
  const installed = parseInstalledAoeTools("  \u001b[32m✓\u001b[0m claude       installed\n  ✗ cursor       not installed\n  ✓ codex        installed\n")
  assert.deepEqual([...installed], ["claude", "codex"])
  await assert.doesNotReject(() => assertHarnessAvailable({ tool: "claude", displayName: "Claude" }, installed))
  await assert.rejects(() => assertHarnessAvailable({ tool: "cursor", displayName: "Cursor" }, installed), /not installed in AoE/)
})

test("provisions Cursor's worktree rule once and protects user-owned rules", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "tars-cursor-"))
  await mkdir(join(worktree, ".git", "info"), { recursive: true })
  await provisionHarnessSkills({ root: ROOT, harness: { key: "cursor", tool: "cursor" }, worktreePath: worktree })
  assert.match(await readFile(join(worktree, ".cursor", "rules", "tars.mdc"), "utf8"), /tars-owned: true/)
  assert.equal((await readFile(join(worktree, ".git", "info", "exclude"), "utf8")).split("\n").filter((line) => line === ".cursor/rules/tars.mdc").length, 1)
  await writeFile(join(worktree, ".cursor", "rules", "tars.mdc"), "user-owned\n")
  await assert.rejects(
    () => provisionHarnessSkills({ root: ROOT, harness: { key: "cursor", tool: "cursor" }, worktreePath: worktree }),
    /not TARS-owned/,
  )
})

test("lane-local provisioning does not touch global skills for non-Cursor harnesses", async () => {
  await assert.doesNotReject(() => provisionWorktreeHarnessRequirements({ root: ROOT, harness: { key: "codex", tool: "codex" }, worktreePath: "/does-not-need-to-exist" }))
})

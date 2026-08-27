import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { assertHarnessAvailable, loadHarnessConfig, parseInstalledAoeTools, provisionHarnessSkills, provisionInstalledHarnesses, provisionOpenCodeCommand, provisionOpenCodePlanAgent, provisionWorktreeHarnessRequirements, resolveHarness, saveHarnessConfig } from "../lib/harnesses.mjs"

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

test("provisions TARS's writable-but-plan-scoped OpenCode agent", async () => {
  const home = await mkdtemp(join(tmpdir(), "tars-opencode-home-"))
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    await provisionOpenCodePlanAgent(ROOT)
    const agent = await readFile(join(home, ".config", "opencode", "agents", "tars-plan.md"), "utf8")
    assert.match(agent, /tars-owned: true/)
    assert.match(agent, /"plans\/\*\*": allow/)
    assert.match(agent, /"\.agent-handoff\/\*\*": allow/)
    assert.match(agent, /Do not describe\s+this\s+session as read-only/)
    await writeFile(join(home, ".config", "opencode", "agents", "tars-plan.md"), "user-owned\n")
    await assert.rejects(() => provisionOpenCodePlanAgent(ROOT), /not TARS-owned/)
  } finally {
    process.env.HOME = originalHome
  }
})

test("provisions a Build command that switches the primary OpenCode session", async () => {
  const home = await mkdtemp(join(tmpdir(), "tars-opencode-home-"))
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    await provisionOpenCodeCommand(ROOT)
    const command = await readFile(join(home, ".config", "opencode", "commands", "tars-build.md"), "utf8")
    assert.match(command, /^agent: build$/m)
    assert.match(command, /^subtask: false$/m)
  } finally {
    process.env.HOME = originalHome
  }
})

test("provisions all discovered supported harnesses independently of role defaults", async () => {
  const home = await mkdtemp(join(tmpdir(), "tars-provisioned-home-"))
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    const provisioned = await provisionInstalledHarnesses({ root: ROOT, installed: new Set(["opencode", "codex", "cursor"]) })
    assert.deepEqual(provisioned, ["opencode", "codex", "cursor"])
    await access(join(home, ".config", "opencode", "agents", "tars-plan.md"))
    await access(join(home, ".config", "opencode", "commands", "tars-build.md"))
    await access(join(home, ".config", "opencode", "skills", "handoff-review", ".tars-owned"))
    await access(join(home, ".codex", "skills", "handoff-review", ".tars-owned"))
  } finally {
    process.env.HOME = originalHome
  }
})

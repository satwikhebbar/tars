import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { assertHarnessAvailable, loadHarnessConfig, loadLaneConfig, parseInstalledAoeTools, provisionConfiguredWorktreeFiles, provisionHarnessSkills, provisionInstalledHarnesses, provisionOpenCodePlanAgent, provisionTarsCli, provisionWorktreeHarnessRequirements, resolveHarness, resolveHarnessModel, saveHarnessConfig } from "../lib/harnesses.mjs"

const ROOT = new URL("../../..", import.meta.url).pathname
const execFileAsync = promisify(execFile)

test("normalizes defaults and resolves custom AoE-backed harnesses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tars-config-"))
  const path = join(directory, "config.json")
  assert.deepEqual(await loadHarnessConfig(path), { defaults: { author: "opencode", reviewer: "codex" }, harnesses: {}, worktreeFiles: [] })
  await saveHarnessConfig({ defaults: { author: "claude", reviewer: "cursor" }, harnesses: { pi: { tool: "pi", displayName: "Pi" } } }, path)
  const config = await loadHarnessConfig(path)
  assert.equal(resolveHarness(config, "pi").tool, "pi")
  assert.equal(resolveHarness(config, "claude").displayName, "Claude Code")
  assert.deepEqual(resolveHarness(config, "codex").launchArgs, ["--approve-for-me"])
  assert.throws(() => resolveHarness(config, "missing"), /Unknown TARS harness/)
})

test("merges harness role defaults and lets repository values override global values", async () => {
  const repo = await mkdtemp(join(tmpdir(), "tars-project-config-"))
  await mkdir(join(repo, ".tars"), { recursive: true })
  await writeFile(join(repo, ".tars", "config.json"), JSON.stringify({ harnesses: { codex: { defaults: { reviewer: { model: "gpt-5.6-terra" } } } } }))
  const configHome = await mkdtemp(join(tmpdir(), "tars-global-config-"))
  const originalXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
  try {
    await saveHarnessConfig({ harnesses: { codex: { defaults: { author: { model: "gpt-5.6-luna" }, reviewer: { model: "gpt-5.6-luna" } } } } })
    const config = await loadLaneConfig({ repoPath: repo })
    assert.equal(resolveHarnessModel(config, "codex", "author"), "gpt-5.6-luna")
    assert.equal(resolveHarnessModel(config, "codex", "reviewer"), "gpt-5.6-terra")
    assert.equal(resolveHarnessModel(config, "codex", "reviewer", "gpt-5.6-astra"), "gpt-5.6-astra")
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdg
  }
})

test("copies configured files from the source repository into a lane worktree", async () => {
  const source = await mkdtemp(join(tmpdir(), "tars-source-"))
  const worktree = await mkdtemp(join(tmpdir(), "tars-worktree-"))
  await mkdir(join(source, "config"), { recursive: true })
  await writeFile(join(source, "config", "local.json"), "local config\n")

  await provisionConfiguredWorktreeFiles({
    config: { worktreeFiles: [{ source: "config/local.json", destination: "config/local.json" }, ".env.local"] },
    repoPath: source,
    worktreePath: worktree,
  }).catch((error) => {
    assert.match(error.message, /ENOENT/)
  })
  assert.equal(await readFile(join(worktree, "config", "local.json"), "utf8"), "local config\n")
})

test("uses repository-local lane configuration over device defaults", async () => {
  const repo = await mkdtemp(join(tmpdir(), "tars-project-config-"))
  const configPath = join(repo, ".tars", "config.json")
  await mkdir(join(repo, ".tars"), { recursive: true })
  await writeFile(configPath, JSON.stringify({ worktreeFiles: [".dev.vars"], defaults: { author: "claude" } }))

  const originalXdg = process.env.XDG_CONFIG_HOME
  const configHome = await mkdtemp(join(tmpdir(), "tars-global-config-"))
  process.env.XDG_CONFIG_HOME = configHome
  try {
    await saveHarnessConfig({ defaults: { author: "opencode", reviewer: "codex" }, worktreeFiles: [".env.local"] })
    const config = await loadLaneConfig({ repoPath: repo })
    assert.deepEqual(config.worktreeFiles, [".dev.vars"])
    assert.equal(config.defaults.author, "claude")
    assert.equal(config.defaults.reviewer, "codex")
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdg
  }
})

test("rejects configured worktree files that escape either root", async () => {
  await assert.rejects(
    () => provisionConfiguredWorktreeFiles({ config: { worktreeFiles: ["../secret"] }, repoPath: "/repo", worktreePath: "/worktree" }),
    /escapes its root/,
  )
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

test("provisions a portable TARS controller command", async () => {
  const home = await mkdtemp(join(tmpdir(), "tars-cli-home-"))
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    await provisionTarsCli(ROOT)
    const launcher = await readFile(join(home, ".local", "bin", "tars"), "utf8")
    assert.match(launcher, /tars-owned: true/)
    assert.match(launcher, /\.local\/share\/tars\/review-loop\/cli\.mjs/)
    await access(join(home, ".local", "share", "tars", "review-loop", "cli.mjs"))
    const handoff = join(home, "handoff.md")
    await writeFile(handoff, "---\nid: valid\ntype: code-review\nworkflow_id: 1\nround: 1\noutcome: approved\n---\n")
    const { stdout } = await execFileAsync(join(home, ".local", "bin", "tars"), ["handoff", "validate", "--path", handoff])
    assert.match(stdout, /^valid: /)
    await writeFile(join(home, ".local", "bin", "tars"), "user-owned\n")
    await assert.rejects(() => provisionTarsCli(ROOT), /not TARS-owned/)
  } finally {
    process.env.HOME = originalHome
  }
})

test("provisions all discovered supported harnesses independently of role defaults", async () => {
  const home = await mkdtemp(join(tmpdir(), "tars-provisioned-home-"))
  const originalHome = process.env.HOME
  process.env.HOME = home
  try {
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true })
    await writeFile(join(home, ".config", "opencode", "commands", "tars-build.md"), "---\ntars-owned: true\n---\n")
    const provisioned = await provisionInstalledHarnesses({ root: ROOT, installed: new Set(["opencode", "codex", "cursor"]) })
    assert.deepEqual(provisioned, ["opencode", "codex", "cursor"])
    await access(join(home, ".config", "opencode", "agents", "tars-plan.md"))
    await assert.rejects(() => access(join(home, ".config", "opencode", "commands", "tars-build.md")))
    await access(join(home, ".local", "bin", "tars"))
    await access(join(home, ".config", "opencode", "skills", "handoff-review", ".tars-owned"))
    await access(join(home, ".codex", "skills", "handoff-review", ".tars-owned"))
  } finally {
    process.env.HOME = originalHome
  }
})

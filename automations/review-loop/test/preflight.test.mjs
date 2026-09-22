import assert from "node:assert/strict"
import test from "node:test"
import { preflightCommand } from "../lib/preflight.mjs"

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

test("passes the author model to OpenCode preflight", () => {
  assert.deepEqual(
    preflightCommand(harness("opencode"), "/tmp/lane", "classify this", "provider/model"),
    ["opencode", ["run", "--pure", "--dir", "/tmp/lane", "--model", "provider/model", "classify this"]],
  )
})

test("omits model flags when no author model is configured", () => {
  assert.deepEqual(
    preflightCommand(harness("codex"), "/tmp/lane", "classify this"),
    ["codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "classify this"]],
  )
})

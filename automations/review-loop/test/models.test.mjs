import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { assertLaneModels, readCodexCatalog } from "../lib/models.mjs"

const exec = promisify(execFile)
const entry = (role, model, key = "codex") => ({ role, model, harness: { key } })

test("rejects provider-prefixed Codex IDs for either role before reading a catalog", async () => {
  for (const role of ["author", "reviewer"]) {
    await assert.rejects(assertLaneModels([entry(role, "openai/gpt-6-luna")], {
      readCatalog: () => assert.fail("syntax must be validated first"),
    }), new RegExp(`${role} model.*Codex expects the bare model ID; use 'gpt-6-luna'`))
  }
})

test("checks both Codex roles using one catalog and rejects unknown IDs", async () => {
  let calls = 0
  const options = { readCatalog: async () => { calls++; return ["gpt-6-luna", "gpt-6.1-sol"] } }
  await assertLaneModels([entry("author", "gpt-6-luna"), entry("reviewer", "gpt-6.1-sol")], options)
  assert.equal(calls, 1)
  await assert.rejects(assertLaneModels([entry("author", "gpt-6-luna"), entry("reviewer", "typo")], options), /reviewer model 'typo'.*Available model IDs: gpt-6-luna, gpt-6.1-sol/)
})

test("validates syntax without imposing a model allowlist on other providers", async () => {
  for (const model of ["", " gpt-6-luna", "gpt-6-luna\n", "--bad", null, 10]) {
    await assert.rejects(assertLaneModels([entry("author", model)]), /model must be/)
  }
  await assert.rejects(assertLaneModels([entry("planning", "gpt-6-luna", "opencode")]), /planning model.*provider\/model/)
  await assertLaneModels([entry("author", "openai/gpt-6-luna", "opencode"), entry("reviewer", "sonnet", "claude")])
  await assertLaneModels([entry("author", "custom/model")], { readCatalog: async () => null })
  await assertLaneModels([entry("author", undefined)], { readCatalog: () => assert.fail("omitted model uses harness default") })
  await assert.rejects(assertLaneModels([entry("author", "gpt-6-luna")], { readCatalog: async () => { throw new Error("unavailable") } }), /unavailable/)
})

async function fixture(t, { account = "chatgpt", provider = "openai", mode = "normal" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tars-models-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = join(directory, "codex"), log = join(directory, "calls.jsonl")
  await writeFile(command, `#!${process.execPath}
const fs = require("node:fs"), rl = require("node:readline").createInterface({ input: process.stdin });
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
rl.on("line", line => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + "\\n");
  if (${JSON.stringify(mode)} === "hang") return;
  if (${JSON.stringify(mode)} === "exit") process.exit(1);
  if (m.id === undefined) return;
  if (${JSON.stringify(mode)} === "error") { console.log(JSON.stringify({id:m.id,error:{message:"catalog unavailable"}})); return; }
  let result;
  if (m.method === "initialize") result = {};
  else if (m.method === "config/read") result = {config:{model_provider:${JSON.stringify(provider)}}};
  else if (m.method === "account/read") result = {account:{type:${JSON.stringify(account)}}};
  else if (m.method === "model/list") result = ${JSON.stringify(mode)} === "invalid" ? {data:[{}]} : {data:[{id:"picker-id",model:m.params.cursor ? "gpt-6.1-sol" : "gpt-6-luna",hidden:true}],nextCursor:m.params.cursor ? null : "page2"};
  else throw Error("Unexpected RPC " + m.method);
  console.log(JSON.stringify({id:m.id,result}));
});
`)
  await chmod(command, 0o700)
  return { command, directory, log, read: (options = {}) => readCodexCatalog({ command, cwd: directory, ...options }) }
}

test("catalog RPC initializes, uses native model IDs, includes hidden models and paginates", async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.read({ harness: { launchArgs: ["--approve-for-me", "--profile", "work", "-c", 'model_provider="openai"'] } }), ["gpt-6-luna", "gpt-6.1-sol"])
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(JSON.parse)
  assert.deepEqual(calls[0].args, ["--profile", "work", "-c", 'model_provider="openai"', "app-server"])
  assert.deepEqual(calls.slice(1).map(({ method }) => method), ["initialize", "initialized", "config/read", "account/read", "model/list", "model/list"])
  assert.equal(calls[5].params.includeHidden, true)
  assert.equal(calls[6].params.cursor, "page2")
})

test("API-key and custom-provider accounts do not use the ChatGPT catalog as an allowlist", async (t) => {
  for (const options of [{ account: "apiKey" }, { provider: "custom" }]) {
    const f = await fixture(t, options)
    assert.equal(await f.read(), null)
    assert.doesNotMatch(await readFile(f.log, "utf8"), /model\/list/)
  }
})

test("catalog errors, malformed responses, early exit, missing executable and timeout fail closed", async (t) => {
  for (const mode of ["error", "invalid", "exit", "hang"]) {
    const f = await fixture(t, { mode })
    await assert.rejects(f.read({ timeoutMs: mode === "hang" ? 100 : 2000 }), /Cannot validate Codex models/)
  }
  await assert.rejects(readCodexCatalog({ command: "/nonexistent/tars-codex" }), /Cannot validate Codex models.*ENOENT/)
})

test("lane start rejects invalid CLI and configured models before issue lookup or AoE, even with planning overridden", async (t) => {
  const f = await fixture(t)
  const config = join(f.directory, "config.json")
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  for (const role of ["author", "reviewer"]) {
    for (const configured of [false, true]) {
      await writeFile(config, JSON.stringify({ harnesses: { codex: { defaults: configured ? { [role]: { model: "openai/gpt-6-luna" } } : {} } } }))
      await assert.rejects(exec(process.execPath, [cli, "lane", "start", "--repo", f.directory, "--issue", "100", "--author", "codex", "--reviewer", "codex", "--planning", "always", "--config", config, "--state", join(f.directory, "state.sqlite"), ...(configured ? [] : [`--${role}-model`, "openai/gpt-6-luna"])], { env: { ...process.env, PATH: f.directory } }), (error) => {
        assert.match(error.stderr, new RegExp(`${role} model.*Codex expects the bare model ID`))
        assert.doesNotMatch(error.stderr, /lane preflight:|started:/)
        return true
      })
    }
  }
  await assert.rejects(readFile(f.log), /ENOENT/)
})

test("lane start rejects an unknown bare reviewer ID before issue lookup or AoE", async (t) => {
  const f = await fixture(t)
  const config = join(f.directory, "config.json")
  await writeFile(config, "{}")
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  await assert.rejects(exec(process.execPath, [cli, "lane", "start", "--repo", f.directory, "--issue", "100", "--author", "codex", "--reviewer", "codex", "--author-model", "gpt-6-luna", "--reviewer-model", "gpt-typo", "--config", config, "--state", join(f.directory, "state.sqlite")], { env: { ...process.env, PATH: f.directory } }), (error) => {
    assert.match(error.stderr, /reviewer model 'gpt-typo' is not in Codex's ChatGPT model catalog/)
    assert.doesNotMatch(error.stderr, /lane preflight:|started:|spawn gh|spawn aoe/)
    return true
  })
  assert.match(await readFile(f.log, "utf8"), /model\/list/)
})

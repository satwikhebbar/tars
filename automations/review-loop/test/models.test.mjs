import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { assertLaneModels, readCodexCatalog, readOpenCodeCatalog } from "../lib/models.mjs"

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
  await assertLaneModels([entry("author", "openai/gpt-6-luna", "opencode"), entry("reviewer", "sonnet", "claude")], { readOpenCode: async () => ["openai/gpt-6-luna"] })
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

async function openCodeFixture(t, { output = "custom/coding-alias\nopenrouter/anthropic/claude-model:free\n", mode = "normal" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tars-opencode-models-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = join(directory, "opencode"), log = join(directory, "calls.jsonl")
  await writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd(),config:process.env.OPENCODE_CONFIG_CONTENT}) + "\\n");
if (${JSON.stringify(mode)} === "hang") setInterval(() => {}, 1000);
else if (${JSON.stringify(mode)} === "error") { console.error("SECRET provider diagnostic"); process.exit(1); }
else process.stdout.write(${JSON.stringify(output)});
`)
  await chmod(command, 0o700)
  return { directory, command, log, read: (options = {}) => readOpenCodeCatalog({ command, cwd: directory, ...options }) }
}

test("OpenCode catalog preserves custom aliases, nested IDs and the effective configuration", async (t) => {
  const f = await openCodeFixture(t, { output: "custom/coding-alias\r\nopenrouter/anthropic/claude-model:free\r\ncustom/coding-alias\r\n" })
  assert.deepEqual(await f.read({ harness: { launchArgs: ["--pure", "--model", "ignored", "--agent", "build"] } }), ["custom/coding-alias", "openrouter/anthropic/claude-model:free"])
  const call = JSON.parse((await readFile(f.log, "utf8")).trim())
  assert.deepEqual(call.args, ["models", "--pure"])
  assert.equal(call.cwd, await realpath(f.directory))
  assert.equal(call.config, process.env.OPENCODE_CONFIG_CONTENT)
})

test("OpenCode validates all roles, queries once per configuration and coexists with Codex", async () => {
  const calls = []
  const options = { cwd: "/repo", readOpenCode: async ({ cwd, harness }) => {
    calls.push([cwd, harness.launchArgs])
    return ["custom/coding-alias", "openrouter/anthropic/claude-model:free"]
  }, readCatalog: async () => ["gpt-6-luna"] }
  await assertLaneModels([
    entry("author", "custom/coding-alias", "opencode"),
    entry("reviewer", "gpt-6-luna"),
    entry("planning", "openrouter/anthropic/claude-model:free", "opencode"),
  ], options)
  assert.equal(calls.length, 1)
  await assertLaneModels([
    { ...entry("author", "custom/coding-alias", "opencode"), harness: { key: "opencode", launchArgs: ["--pure"] } },
    entry("reviewer", "custom/coding-alias", "opencode"),
  ], options)
  assert.equal(calls.length, 3)
  for (const role of ["author", "reviewer", "planning", "classifier"]) {
    await assert.rejects(assertLaneModels([entry(role, "custom/typo", "opencode")], options), new RegExp(`${role} OpenCode model.*Model is not in the effective catalog`))
    await assert.rejects(assertLaneModels([entry(role, "disabled/model", "opencode")], options), /Provider 'disabled' is unavailable/)
  }
  await assertLaneModels([entry("author", undefined, "opencode")], { readOpenCode: () => assert.fail("omitted selection uses the harness default") })
})

test("OpenCode catalog command errors, empty/malformed output, missing binary and timeout fail closed", async (t) => {
  for (const output of ["", "Welcome to OpenCode\ncustom/model\n", "custom/\n", "/model\n", "custom/bad model\n"]) {
    const f = await openCodeFixture(t, { output })
    await assert.rejects(f.read(), /Cannot validate OpenCode models.*empty or malformed/)
  }
  for (const mode of ["error", "hang"]) {
    const f = await openCodeFixture(t, { mode })
    await assert.rejects(f.read({ timeoutMs: mode === "hang" ? 100 : 2000 }), (error) => {
      assert.match(error.message, /Cannot validate OpenCode models/)
      assert.doesNotMatch(error.message, /SECRET/)
      return true
    })
  }
  await assert.rejects(readOpenCodeCatalog({ command: "/nonexistent/tars-opencode" }), /Cannot validate OpenCode models.*ENOENT/)
})

test("CLI rejects unavailable OpenCode author, reviewer and planning selections before AoE or issue lookup", async (t) => {
  const f = await openCodeFixture(t)
  const config = join(f.directory, "config.json")
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  for (const [role, flag] of [["author", "author"], ["reviewer", "reviewer"], ["planning", "plan"]]) {
    for (const configured of [false, true]) {
      await writeFile(config, JSON.stringify({ harnesses: { opencode: { defaults: configured ? { [role]: { model: "custom/typo" } } : {} } } }))
      await assert.rejects(exec(process.execPath, [cli, "lane", "start", "--repo", f.directory, "--issue", "100", "--author", "opencode", "--reviewer", "opencode", "--planning", "always", "--config", config, "--state", join(f.directory, "state.sqlite"), ...(configured ? [] : [`--${flag}-model`, "custom/typo"])], { env: { ...process.env, PATH: f.directory } }), (error) => {
        assert.match(error.stderr, new RegExp(`${role} OpenCode model 'custom/typo' is unavailable`))
        assert.doesNotMatch(error.stderr, /lane preflight:|started:|spawn gh|spawn aoe/)
        return true
      })
    }
  }
})

test("CLI validates explicit/configured classifier models in isolation, before fallback or issue lookup", async (t) => {
  const f = await openCodeFixture(t)
  const config = join(f.directory, "config.json")
  const aoe = join(f.directory, "aoe")
  await writeFile(aoe, `#!${process.execPath}\nconsole.log("✓ opencode installed");\n`)
  await chmod(aoe, 0o700)
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  for (const configured of [false, true]) {
    await writeFile(config, JSON.stringify({ harnesses: { opencode: { defaults: configured ? { classifier: { model: "isolated/typo" } } : {} } } }))
    await assert.rejects(exec(process.execPath, [cli, "lane", "start", "--repo", f.directory, "--issue", "100", "--author", "opencode", "--reviewer", "opencode", "--config", config, "--state", join(f.directory, "state.sqlite"), ...(configured ? [] : ["--classifier-model", "isolated/typo"])], { env: { ...process.env, PATH: f.directory } }), (error) => {
      assert.match(error.stderr, /classifier OpenCode model 'isolated\/typo' is unavailable/)
      assert.doesNotMatch(error.stderr, /lane preflight:|started:|spawn gh/)
      return true
    })
  }
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call.args, ["models", "--pure"])
    assert.notEqual(call.cwd, await realpath(f.directory))
  }
})

test("CLI does not pass a project author model to OpenCode classification by default", async (t) => {
  const f = await openCodeFixture(t)
  const config = join(f.directory, "config.json")
  await writeFile(config, "{}")
  for (const [name, script] of [
    ["aoe", 'if (process.argv[2] === "agents") console.log("✓ opencode installed"); else { console.error("STOP before worktree creation"); process.exit(1); }'],
    ["gh", 'console.log(JSON.stringify({number:100,title:"Test isolated classification",body:"Implement a small fix",url:"https://example.test/issues/100",labels:[]}));'],
  ]) {
    const command = join(f.directory, name)
    await writeFile(command, `#!${process.execPath}\n${script}\n`)
    await chmod(command, 0o700)
  }
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  await assert.rejects(exec(process.execPath, [cli, "lane", "start", "--repo", f.directory, "--issue", "100", "--author", "opencode", "--reviewer", "opencode", "--author-model", "custom/coding-alias", "--config", config, "--state", join(f.directory, "state.sqlite")], { env: { ...process.env, PATH: f.directory } }), (error) => {
    assert.match(error.stderr, /STOP before worktree creation/)
    return true
  })
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(JSON.parse)
  assert.deepEqual(calls[0].args, ["models"])
  assert.equal(calls[0].cwd, await realpath(f.directory))
  const classifier = calls.find(({ args }) => args[0] === "run")
  assert.ok(classifier)
  assert.ok(classifier.args.includes("--pure"))
  assert.ok(!classifier.args.includes("--model"))
  assert.notEqual(classifier.cwd, calls[0].cwd)
})

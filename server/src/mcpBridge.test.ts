import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` | ${detail}` : ""}`);
  }
};

const RUNTIME = join(process.cwd(), "..", "runtime");
const dir = mkdtempSync(join(tmpdir(), "jaroku-bridge-"));

function python(script: string): Promise<Record<string, unknown>> {
  const file = join(dir, `case-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, `import json, sys\nsys.path.insert(0, ${JSON.stringify(RUNTIME)})\nfrom tool_templates import mcp_bridge as B\n${script}\n`);
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "python", file], { cwd: RUNTIME, env: { ...process.env, JAROKU_RUN_ID: "" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", () => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        resolve({ crashed: `${out}\n${err}`.slice(-600) });
      }
    });
  });
}

console.log("\nat call time a redirect cannot leave the endpoint's origin");
{
  const result = await python(`
import asyncio, httpx
seen = []
def answer(request):
    seen.append(str(request.url))
    if request.url.path == "/mcp":
        return httpx.Response(307, headers={"location": LOCATION})
    return httpx.Response(200, text="INTERNAL-METADATA")
async def attempt():
    async with httpx.AsyncClient(transport=httpx.MockTransport(answer), follow_redirects=True) as client:
        client.event_hooks["response"].append(B.redirect_guard("https://mcp.example.test/mcp"))
        return (await client.post("https://mcp.example.test/mcp", json={})).text
out = {}
for name, LOCATION in [("foreign", "http://169.254.169.254/latest"), ("scheme", "http://mcp.example.test/mcp/"), ("port", "https://mcp.example.test:8443/mcp/"), ("same", "/mcp/")]:
    seen.clear()
    try:
        body = asyncio.run(attempt())
        out[name] = {"body": body, "seen": len(seen)}
    except Exception as exc:
        out[name] = {"refused": str(exc), "seen": len(seen)}
print(json.dumps(out))
`);
  const cases = result as Record<string, { refused?: string; body?: string; seen: number }>;
  check(!result["crashed"], "the bridge loads and runs", String(result["crashed"] ?? ""));
  check(Boolean(cases["foreign"]?.refused), "another host is refused", JSON.stringify(cases["foreign"]));
  check(cases["foreign"]?.seen === 1, "...and is never requested", String(cases["foreign"]?.seen));
  check(!String(cases["foreign"]?.refused).includes("INTERNAL"), "...and its body reaches nobody");
  check(Boolean(cases["scheme"]?.refused), "a change of scheme is refused");
  check(Boolean(cases["port"]?.refused), "a change of port is refused");
  check(cases["same"]?.body === "INTERNAL-METADATA", "the same origin is still followed", JSON.stringify(cases["same"]));
}

const MANIFEST = JSON.stringify({
  servers: [{
    id: "alpha",
    endpoint: "https://a.test/mcp",
    auth_env_key: null,
    tools: [
      { name: "read_page", description: "r", input_schema: { type: "object", properties: {} }, impact: "low", impact_reason: "its name begins with read" },
      { name: "send_message", description: "s", input_schema: { type: "object", properties: {} }, impact: "high", impact_reason: "its name begins with send" },
    ],
  }],
});

const CALL_EVERYTHING = `
import os
asked = []
called = []
B._confirm = lambda server, name, args, reason, impact="high", first_call=True: asked.append({"tool": name, "reason": reason})
B._run_call = lambda endpoint, token, tool, args: called.append(tool)
B._result_text = lambda server, name, result: "ok"
tools = B.build_tools(json.loads(MANIFEST))
for tool in tools:
    tool.invoke({})
print(json.dumps({"asked": asked, "called": called, "names": [t.name for t in tools]}))
`;

async function bridgeRun(scope: unknown): Promise<{ asked: { tool: string; reason: string }[]; called: string[]; names: string[]; crashed?: string }> {
  const env = scope === undefined ? "" : `import os\nos.environ["JAROKU_MCP_SCOPE"] = ${JSON.stringify(JSON.stringify(scope))}\n`;
  const result = await python(`MANIFEST = ${JSON.stringify(MANIFEST)}\n${env}${CALL_EVERYTHING}`);
  return result as never;
}

console.log("\nthe host's scope governs the gate at run time");
{
  const none = await bridgeRun(undefined);
  check(!none.crashed, "the bridge runs", String(none.crashed ?? ""));
  check(JSON.stringify(none.asked.map((a) => a.tool)) === JSON.stringify(["send_message"]), "with no scope, as in a copied out project, the manifest governs");

  const raised = await bridgeRun({
    servers: { alpha: { tools: { read_page: { impact: "high", reason: "you marked it high impact" }, send_message: { impact: "high" } } } },
  });
  check(raised.asked.map((a) => a.tool).join() === "read_page,send_message", "a raised tool asks", JSON.stringify(raised.asked));
  check(raised.asked[0]?.reason === "you marked it high impact", "...and the tray is told why");
  check(raised.asked[1]?.reason === "its name begins with send", "an unchanged tool keeps the manifest's reason");

  const lowered = await bridgeRun({ servers: { alpha: { tools: { read_page: { impact: "low" }, send_message: { impact: "low" } } } } });
  check(lowered.asked.length === 0, "a lowered tool does not ask", JSON.stringify(lowered.asked));
  check(lowered.called.length === 2, "...and both still run");

  const broken = await python(`import os\nos.environ["JAROKU_MCP_SCOPE"] = "not json"\ntry:\n    B.build_tools(json.loads(${JSON.stringify(MANIFEST)}))\n    print(json.dumps({"raised": False}))\nexcept B.ManifestError:\n    print(json.dumps({"raised": True}))\n`);
  check(broken["raised"] === true, "an unreadable scope is refused rather than ignored", JSON.stringify(broken));
}

console.log("\nan eval's run can never call a high impact tool unasked");
{
  const evalShape = await python(`
import os
os.environ["JAROKU_RUN_ID"] = "eval-run"
os.environ["JAROKU_MCP_CONFIRM"] = "require"
os.environ.pop("JAROKU_CONTROL_DIR", None)
called = []
B._run_call = lambda endpoint, token, tool, args: called.append(tool)
B._result_text = lambda server, name, result: "ok"
tool = {t.name: t for t in B.build_tools(json.loads(${JSON.stringify(MANIFEST)}))}["send_message"]
try:
    tool.invoke({})
    print(json.dumps({"called": called, "refused": False}))
except B.ToolNotApproved:
    print(json.dumps({"called": called, "refused": True}))
`);
  check(evalShape["refused"] === true, "with nobody able to answer, the call is refused", JSON.stringify(evalShape));
  check((evalShape["called"] as string[] | undefined)?.length === 0, "...and nothing reaches the server");

  const repoRoot = join(process.cwd(), "src");
  const runner = readFileSync(join(repoRoot, "evalRunner.ts"), "utf8");
  const index = readFileSync(join(repoRoot, "index.ts"), "utf8");
  check(/JAROKU_MCP_CONFIRM: "require"/.test(runner), "the eval runner sets that on every job");
  check(/runSetup: async[\s\S]{0,1500}JAROKU_CONTROL_DIR: CHECKPOINT_DIR/.test(index), "and the app gives an eval's run the route to ask");
  check(/JAROKU_RESUME_RUN_ID: runId,\s+JAROKU_RUN_ID: runId,\s+JAROKU_CONTROL_DIR: CHECKPOINT_DIR/.test(index), "and a resumed run keeps that route too");
}

console.log("\nunder a host the environment cannot turn the gate off");
{
  const skipped = await python(`
import os
os.environ["JAROKU_RUN_ID"] = "hosted-run"
os.environ["JAROKU_MCP_CONFIRM"] = "skip"
os.environ.pop("JAROKU_CONTROL_DIR", None)
called = []
B._run_call = lambda endpoint, token, tool, args: called.append(tool)
B._result_text = lambda server, name, result: "ok"
tool = {t.name: t for t in B.build_tools(json.loads(${JSON.stringify(MANIFEST)}))}["send_message"]
try:
    tool.invoke({})
    print(json.dumps({"called": called, "refused": False}))
except B.ToolNotApproved:
    print(json.dumps({"called": called, "refused": True}))
`);
  check(skipped["refused"] === true, "skip is ignored while a host owns the run", JSON.stringify(skipped));
  const standalone = await python(`
import os
os.environ.pop("JAROKU_RUN_ID", None)
os.environ["JAROKU_MCP_CONFIRM"] = "skip"
called = []
B._run_call = lambda endpoint, token, tool, args: called.append(tool)
B._result_text = lambda server, name, result: "ok"
tool = {t.name: t for t in B.build_tools(json.loads(${JSON.stringify(MANIFEST)}))}["send_message"]
tool.invoke({})
print(json.dumps({"called": called}))
`);
  check(JSON.stringify(standalone["called"]) === JSON.stringify(["send_message"]), "a copied out project run by its owner still honours it", JSON.stringify(standalone));
}

console.log("\nparameters named like LangChain's own internals arrive intact");
{
  const manifest = JSON.stringify({
    servers: [{
      id: "alpha", endpoint: "https://a.test/mcp", auth_env_key: null,
      tools: [{
        name: "read_page", description: "r", impact: "low", impact_reason: "r",
        input_schema: {
          type: "object",
          properties: { q: { type: "string" }, config: { type: "string" }, run_manager: { type: "string" }, self: { type: "string" }, callbacks: { type: "string" } },
          required: ["config", "run_manager"],
        },
      }],
    }],
  });
  const delivered = await python(`
import asyncio
sent = []
B._run_call = lambda endpoint, token, tool, args: sent.append(args)
B._result_text = lambda server, name, result: "ok"
tool = B.build_tools(json.loads(${JSON.stringify(manifest)}))[0]
args = {"q": "hello", "config": "c", "run_manager": "r", "self": "s", "callbacks": "k"}
tool.invoke(args)
asyncio.run(tool.ainvoke(args))
print(json.dumps({"sent": sent}))
`);
  const sent = (delivered["sent"] ?? []) as Record<string, string>[];
  check(!delivered["crashed"], "the call goes through", String(delivered["crashed"] ?? ""));
  check(sent.length === 2, "by invoke and by ainvoke", String(sent.length));
  for (const args of sent) {
    check(args["config"] === "c" && args["run_manager"] === "r", "config and run_manager are delivered", JSON.stringify(args));
    check(args["self"] === "s", "self is delivered", JSON.stringify(args));
    check(args["q"] === "hello" && args["callbacks"] === "k", "and so is everything else", JSON.stringify(args));
  }
}

console.log("\nany recorded schema builds a tool a model can be given");
{
  const shapes: Record<string, unknown> = {
    "no properties": { type: "object" },
    "a string": { type: "string" },
    "an array": { type: "array", items: {} },
    "properties with no type": { properties: { a: { type: "string" } } },
    "anyOf": { anyOf: [{ type: "object", properties: { a: {} } }] },
    "a ref": { $ref: "#/$defs/x", $defs: { x: { type: "object" } } },
    "a null type": { type: null },
    "a type list": { type: ["object", "null"], properties: { a: { type: "string" } } },
    "required as a string": { type: "object", properties: { a: { type: "string" } }, required: "a" },
    "properties as a string": { type: "object", properties: "nope" },
  };
  const built = await python(`
from langchain_core.utils.function_calling import convert_to_openai_tool
shapes = json.loads(${JSON.stringify(JSON.stringify(shapes))})
out = {}
B._run_call = lambda endpoint, token, tool, args: None
B._result_text = lambda server, name, result: "ok"
for label, schema in shapes.items():
    manifest = {"servers": [{"id": "a", "endpoint": "https://a.test/mcp", "auth_env_key": None, "tools": [{"name": "read_page", "description": "r", "impact": "low", "impact_reason": "r", "input_schema": schema}]}]}
    try:
        tool = B.build_tools(manifest)[0]
        keys = sorted(tool.args.keys())
        parameters = convert_to_openai_tool(tool)["function"]["parameters"]
        out[label] = {"args": keys, "type": parameters.get("type")}
    except Exception as exc:
        out[label] = {"raised": f"{type(exc).__name__}: {exc}"}
print(json.dumps(out))
`);
  for (const label of Object.keys(shapes)) {
    const row = built[label] as { args?: string[]; type?: unknown; raised?: string } | undefined;
    check(row !== undefined && !row.raised, `${label}: tool.args does not raise`, row?.raised ?? String(built["crashed"] ?? ""));
    check(row?.type === "object", `${label}: a model is told it takes an object`, JSON.stringify(row));
  }
  check(!(built["properties as a string"] as { args?: string[] })?.args?.includes("n"), "a string of properties is not read character by character");
}

console.log("\nthe runner's .env loader will not read a gate setting");
{
  const envFile = join(dir, "reserved.env").replace(/\\/g, "/");
  writeFileSync(envFile, "JAROKU_MCP_CONFIRM=skip\nJAROKU_PERMISSION_MODE=fast\nJAROKU_MCP_SERVERS=-\nJAROKU_CTRL_TOKEN=guess\nSOME_REAL_KEY=kept\n");
  const loaded = await python(`
from pathlib import Path
from jaroku_interceptor.env import load_env
print(json.dumps({"loaded": load_env(Path(${JSON.stringify(envFile)}), verbose=False)}))
`);
  check(JSON.stringify(loaded["loaded"]) === JSON.stringify(["SOME_REAL_KEY"]), "only the real key is loaded", JSON.stringify(loaded));
}

console.log("\nthe bridge says truthfully which call is a tool's first in the run");
{
  const callTwice = (env: string) => python(`
import os, importlib, tempfile
os.environ["JAROKU_RUN_ID"] = "run-modes"
${env}
B = importlib.reload(B)
asked = []
def confirm(server, name, args, reason, impact="high", first_call=True):
    asked.append({"tool": name, "reason": reason, "impact": impact, "first": first_call})
B._confirm = confirm
B._run_call = lambda endpoint, token, tool, args: None
B._result_text = lambda server, name, result: "ok"
tools = {t.name: t for t in B.build_tools(json.loads(${JSON.stringify(MANIFEST)}))}
for name in ["read_page", "read_page", "send_message", "send_message"]:
    tools[name].invoke({})
print(json.dumps({"asked": asked}))
`) as Promise<{ asked?: { tool: string; reason: string; impact: string; first: boolean }[]; crashed?: string }>;
  const local = `os.environ["JAROKU_CONTROL_DIR"] = tempfile.mkdtemp()\nos.environ.pop("JAROKU_CONTROL_PLANE_URL", None)\n`;

  const strict = await callTwice(`${local}os.environ["JAROKU_PERMISSION_MODE"] = "strict"`);
  const asks = strict.asked ?? [];
  check(!strict.crashed, "the bridge runs", String(strict.crashed ?? ""));
  check(asks.map((a) => `${a.tool}:${a.first}`).join() === "read_page:true,read_page:false,send_message:true,send_message:false", "each ask says whether it is that tool's first call in the run, not always the first", JSON.stringify(asks));
  check(asks.filter((a) => a.tool === "read_page").every((a) => a.impact === "low" && a.reason === "Strict mode confirms every tool call"), "...with the impact and reason it always gave", JSON.stringify(asks));

  const smart = await callTwice(`${local}os.environ["JAROKU_PERMISSION_MODE"] = "smart"`);
  check((smart.asked ?? []).map((a) => `${a.tool}:${a.first}`).join() === "send_message:true,send_message:false", "a high impact tool called twice says so on its second ask too", JSON.stringify(smart.asked));
  check(!(smart.asked ?? []).some((a) => a.tool === "read_page"), "and who is asked is unchanged: a read in Smart still does not ask");

  const fresh = await python(`
import os, importlib, tempfile
os.environ["JAROKU_CONTROL_DIR"] = tempfile.mkdtemp()
os.environ["JAROKU_PERMISSION_MODE"] = "strict"
B = importlib.reload(B)
asked = []
B._confirm = lambda server, name, args, reason, impact="high", first_call=True: asked.append([os.environ["JAROKU_RUN_ID"], first_call])
B._run_call = lambda endpoint, token, tool, args: None
B._result_text = lambda server, name, result: "ok"
tool = {t.name: t for t in B.build_tools(json.loads(${JSON.stringify(MANIFEST)}))}["read_page"]
for run in ["run-one", "run-one", "run-two"]:
    os.environ["JAROKU_RUN_ID"] = run
    tool.invoke({})
print(json.dumps({"asked": asked}))
`);
  check(JSON.stringify(fresh["asked"]) === JSON.stringify([["run-one", true], ["run-one", false], ["run-two", true]]), "a new run starts every tool's count again", JSON.stringify(fresh));
}

console.log("\na missing credential is sent to the panel, not to a file a hosted workspace does not have");
{
  const keyed = JSON.stringify({
    servers: [{
      id: "alpha", endpoint: "https://a.test/mcp", auth_env_key: "JAROKU_MCP_ALPHA_TOKEN",
      tools: [{ name: "read_page", description: "r", input_schema: { type: "object", properties: {} }, impact: "low", impact_reason: "r" }],
    }],
  });
  const missing = await python(`
import os
os.environ.pop("JAROKU_MCP_ALPHA_TOKEN", None)
os.environ["JAROKU_MCP_CONFIRM"] = "skip"
called = []
B._run_call = lambda endpoint, token, tool, args: called.append(tool)
tool = B.build_tools(json.loads(${JSON.stringify(keyed)}))[0]
try:
    tool.invoke({})
    print(json.dumps({"raised": None, "called": called}))
except Exception as exc:
    print(json.dumps({"raised": str(exc), "called": called}))
`);
  const said = String(missing["raised"] ?? "");
  check(said.includes("JAROKU_MCP_ALPHA_TOKEN is not set") && said.includes("Add its credential in the MCP panel."), "the run is told which credential is missing and where it is added", said || JSON.stringify(missing));
  check(!said.includes("runtime/.env"), "...and is not pointed at runtime/.env", said);
  check(JSON.stringify(missing["called"]) === "[]", "and nothing is called without it", JSON.stringify(missing["called"]));
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

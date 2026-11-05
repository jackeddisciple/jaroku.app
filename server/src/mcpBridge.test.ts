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

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

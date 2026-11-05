import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

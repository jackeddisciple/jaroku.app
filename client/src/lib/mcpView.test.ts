import { endpointHint, endpointProblem, typingScheme } from "./mcpView.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` | ${detail}` : ""}`);
  }
};

console.log("\nan address is checked before it is sent");
{
  check("an https address passes", endpointProblem("https://mcp.example.com/mcp") === null);
  check("...and so does a local http one", endpointProblem("  http://127.0.0.1:8931/mcp  ") === null);
  check("nothing typed is not a problem yet", endpointProblem("   ") === null);

  const bare = endpointProblem("mcp.example.com/mcp");
  check("an address with no scheme is named as one", bare !== null && /no scheme/.test(bare.message), bare?.message);
  check("...with https offered for a public host", bare?.suggestion === "https://mcp.example.com/mcp", String(bare?.suggestion));
  const local = endpointProblem("127.0.0.1:8931/mcp");
  check("...and http for this machine", local?.suggestion === "http://127.0.0.1:8931/mcp", String(local?.suggestion));
  check("...by name as well as by number", endpointProblem("localhost:8931/mcp")?.suggestion === "http://localhost:8931/mcp");

  const ftp = endpointProblem("ftp://example.com/mcp");
  check("another scheme is refused by name", ftp !== null && ftp.message.includes("ftp://") && ftp.suggestion === null, ftp?.message);
  const stdio = endpointProblem("stdio:///usr/local/bin/server");
  check("stdio is refused with its reason", stdio !== null && /someone else's program/.test(stdio.message), stdio?.message);
  check("an address with a space in it is refused", /space/.test(endpointProblem("https://exa mple.com")?.message ?? ""));
  check("every refusal says nothing was sent", [bare, local, ftp, endpointProblem("https://exa mple.com")].every((p) => /not sent/.test(p?.message ?? "")));
}

console.log("\nthe form does not interrupt somebody who is still typing");
{
  for (const typed of ["h", "ht", "http", "https", "https:", "https:/", "https://"]) {
    check(`"${typed}" is the start of a scheme`, typingScheme(typed) && endpointHint(typed) === null);
  }
  check("a single word is left alone", endpointHint("exam") === null);
  check("a host is worth a hint", endpointHint("example.com")?.suggestion === "https://example.com");
  check("...and so is a host with a port", endpointHint("localhost:8931")?.suggestion === "http://localhost:8931");
  check("a full address needs no hint", endpointHint("https://example.com/mcp") === null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

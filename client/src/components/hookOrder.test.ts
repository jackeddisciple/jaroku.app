// No hook after a component's early return.
//
// A HOOK BELOW `if (…) return null` RUNS ON SOME RENDERS AND NOT OTHERS, and React counts them: the
// render that skips it and the next that reaches it disagree, React throws #310 ("rendered more hooks
// than during the previous render"), and with no boundary above it the whole window goes blank. The
// Evals run bar did exactly this — `if (!selectedDatasetId) return null;` and then Run again's
// hand-off hook — so opening Evals before a dataset was chosen blanked the desktop app.
//
// A static render never sees it: it renders once. So the rule is read off the source. It is a scan
// of the component's own level (two-space indent), which is where both the return and the hook live
// when this goes wrong; and it proves itself on a sample first, so a scan that stopped matching
// cannot report success.
//
//   npm run test:hook-order

import { check, done, read, sourceFiles } from "../lib/icons/harness.ts";

const FN = /^(export\s+)?(default\s+)?function\s+([A-Z]\w*|use[A-Z]\w*)\s*[(<]/;
const HOOK = /^ {2}(?:(?:const|let)\s.*=\s*)?(?:React\.)?use[A-Z]\w*\s*[<(]/;
const RETURN_LINE = /^ {2}if \(.*\)\s*return\b/;
const IF_BLOCK = /^ {2}if \(.*\)\s*\{\s*$/;

/** Every hook a component or custom hook calls after its own early return, as `line: text`. */
export function hooksAfterReturn(source: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  let inside = false;
  let returnedAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (FN.test(l)) {
      inside = true;
      returnedAt = 0;
      continue;
    }
    if (!inside) continue;
    if (l.startsWith("}")) {
      inside = false;
      continue;
    }
    if (RETURN_LINE.test(l)) {
      returnedAt ||= i + 1;
      continue;
    }
    if (IF_BLOCK.test(l)) {
      for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("  }"); j++) {
        if (/^ {4}return\b/.test(lines[j]!)) {
          returnedAt ||= i + 1;
          break;
        }
      }
      continue;
    }
    if (returnedAt && HOOK.test(l)) found.push(`${i + 1}: ${l.trim()}`);
  }
  return found;
}

console.log("\nthe scan finds a hook after an early return");
{
  const bad = [
    "export function Bar() {",
    "  const a = useStore((s) => s.a);",
    "  if (!a) return null;",
    "  const b = useStore((s) => s.b);",
    "  useEffect(() => {}, [b]);",
    "  return null;",
    "}",
  ].join("\n");
  check("a selector and an effect below `return null` are both found", hooksAfterReturn(bad).length === 2, JSON.stringify(hooksAfterReturn(bad)));
  const blockReturn = ["function Baz() {", "  if (x) {", "    return null;", "  }", "  useState(0);", "}"].join("\n");
  check("so is one below a block that returns", hooksAfterReturn(blockReturn).length === 1);
  const fine = ["function Ok() {", "  const a = useStore((s) => s.a);", "  useEffect(() => {}, []);", "  if (!a) return null;", "  return a;", "}"].join("\n");
  check("hooks above the return are fine", hooksAfterReturn(fine).length === 0);
}

console.log("\nno component calls a hook after its early return");
{
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (file.includes(".test.")) continue;
    for (const hit of hooksAfterReturn(read(file))) offenders.push(`${file}:${hit}`);
  }
  check(`every component's hooks run on every render (${sourceFiles().length} files)`, offenders.length === 0, offenders.join("\n       "));
}

done();

// The dataset builder and its rubric editor: what they let somebody type, and what they refuse.
//
//   npm run test:dataset-builder

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const kept = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => void kept.set(k, v),
  removeItem: (k: string) => void kept.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { parseWeight, nextCriterionId, rubricProblem } = await import("./DatasetBuilder.tsx");

console.log("\na weight is typed as text, and read as a number only when it is one");
{
  // `Number("0.")` is 0, so a field that re-rendered the number swallowed the point: "0.25" became "25".
  check(parseWeight("0.") === 0, "a half-typed decimal is still a weight, not a reason to drop the point");
  check(parseWeight("0.25") === 0.25, "0.25 is 0.25");
  check(parseWeight(".5") === 0.5, ".5 is 0.5");
  check(parseWeight("abc") === null && parseWeight("") === null && parseWeight("-1") === null, "text, nothing and a negative are not weights");
  check(parseWeight("1e-9") === null, "nor is scientific notation");
  check(parseWeight("101") === null, "nor anything past 100");
}

console.log("\na new criterion never takes an id already in use");
{
  // From the count: add two, remove the first, add another — two `criterion_5`s, one score.
  const after = [{ id: "correctness" }, { id: "grounding" }, { id: "tone" }, { id: "criterion_5" }];
  check(nextCriterionId(after) === "criterion_6", `one past the highest (${nextCriterionId(after)})`);
  check(nextCriterionId([{ id: "a" }]) === "criterion_1", "and the first one is criterion_1");
}

console.log("\na draft is checked before it can be saved");
{
  const c = (over: Record<string, string>) => ({ id: "x", label: "X", description: "is it x", weight: "1", ...over });
  check(rubricProblem([c({})]) === null, "a complete criterion passes");
  check(/share the id/.test(rubricProblem([c({}), c({ label: "Y" })]) ?? ""), "two under one id are refused");
  check(/needs a name/.test(rubricProblem([c({ label: " " })]) ?? ""), "a nameless one is refused");
  check(/needs a description/.test(rubricProblem([c({ description: "" })]) ?? ""), "so is one with no description");
  check(/weight must be/.test(rubricProblem([c({ weight: "abc" })]) ?? ""), "and one whose weight is not a number");
  check(/above zero/.test(rubricProblem([c({ weight: "0" })]) ?? ""), "and a rubric whose weights are all zero");
}

console.log("\nthe builder, rendered");
{
  const { createElement } = await import("react");
  const { markup, seed } = await import("../lib/testRender.ts");
  const { useBuildStore } = await import("../store/buildStore.ts");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { DatasetBuilder } = await import("./DatasetBuilder.tsx");
  seed(useBuildStore, { activeAgentId: "liven" } as never);
  seed(useEvalStore, {
    datasetsByAgent: { liven: [{ id: "d1", agent_id: "liven", name: "Screening cases", created_at: "", updated_at: "" }] },
    selectedDatasetByAgent: { liven: "d1" },
    examplesByDataset: { d1: [{ id: "x1", dataset_id: "d1", input: "Role: QA --- résumé", expected: null, notes: null, position: 0, created_at: "" }] },
  } as never);
  const html = markup(createElement(DatasetBuilder));
  const add = /<textarea[^>]*aria-label="New case input"[^>]*>/.exec(html)?.[0] ?? "";
  check(add !== "", "a new case is typed into a box, not a one-line field", html.slice(0, 200));
  check(/spellcheck="false"/i.test(add) && /autocorrect="off"/i.test(add) && /autocapitalize="off"/i.test(add),
    "with nothing in it corrected — `---` and straight quotes stay as typed", add);
  const remove = /<button[^>]*aria-label="Remove case 1"[^>]*>/.exec(html)?.[0] ?? "";
  check(/focus-visible:opacity-100/.test(remove), "a case's delete shows on keyboard focus, not only on hover", remove);
  check(/self-start/.test(remove), "and is only its own size, not a strip down the case's edge", remove);
  const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(words.includes("Check answers against expected") && words.includes("Word") && words.includes("Pattern"),
    "a dataset says how its answers are checked against expected", words.slice(0, 300));
}

console.log("\na dataset can leave the tab, be found in, and keep its notes");
{
  const { examplesToCsv } = await import("../lib/evalExport.ts");
  const { csvToExamples } = await import("../lib/csv.ts");
  const cases = [
    { input: 'Role: QA\n---\nCandidate said "I test things"', expected: "decline", notes: "the classic" },
    { input: "Role: SRE", expected: null, notes: null },
  ];
  const back = csvToExamples(examplesToCsv(cases)).examples;
  check(back.length === 2 && back[0]?.input === cases[0]!.input && back[0]?.expected === "decline",
    "an exported dataset imports back as it was — newlines, quotes and all", JSON.stringify(back[0]));

  const { createElement } = await import("react");
  const { markup, seed } = await import("../lib/testRender.ts");
  const { useBuildStore } = await import("../store/buildStore.ts");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { DatasetBuilder } = await import("./DatasetBuilder.tsx");
  seed(useBuildStore, { activeAgentId: "liven" } as never);
  const long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
  seed(useEvalStore, {
    datasetsByAgent: { liven: [{ id: "d1", agent_id: "liven", name: "Screening cases", created_at: "", updated_at: "" }] },
    selectedDatasetByAgent: { liven: "d1" },
    examplesByDataset: { d1: Array.from({ length: 7 }, (_, i) => ({
      id: `x${i}`, dataset_id: "d1", input: i === 0 ? long : `case ${i}`, expected: null, notes: i === 1 ? "why this case exists" : null, position: i, created_at: "",
    })) },
  } as never);
  const html = markup(createElement(DatasetBuilder));
  const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(/aria-label="Find a case"/.test(html), "a long list of cases can be searched");
  check(words.includes("show more"), "a long case folds, with a way to read the rest");
  // WebKit hid the folded lines but kept their height: a blank block above "show more".
  check(/class="clamp-lines" style="--clamp:4"/.test(html), "folded by the shared class, four lines", (/<span class="clamp-lines[^>]*>/.exec(html) ?? [""])[0]);
  // AND THE BUTTON AROUND IT IS A BLOCK: WebKit sized an inline-block button from the unfolded text.
  const caseButton = /<button[^>]*title="Click to edit"[^>]*>(?=<span class="clamp-lines)/.exec(html)?.[0] ?? "";
  check(/class="block /.test(caseButton), "inside a button laid out as a block, which WebKit then sizes to the fold", caseButton);
  const { readFileSync } = await import("node:fs");
  const rule = /\.clamp-lines \{[^}]*\}/.exec(readFileSync("src/index.css", "utf8"))?.[0] ?? "";
  check(/max-height: calc\(var\(--clamp\) \* 1lh\)/.test(rule) && /max-height: calc\(var\(--clamp\) \* 1\.4em\)/.test(rule),
    "and that class takes the hidden lines' height away, not only their text", rule);
  check(words.includes("why this case exists") && words.includes("+ note"), "notes are shown, and can be added", words.slice(0, 200));
  check(/aria-label="Export these cases as a CSV"/.test(html) && /aria-label="Duplicate this dataset"/.test(html), "and a dataset can be exported and duplicated");
}

console.log("\nsaving a test input opens the form from the bar and from the overflow menu alike");
{
  // The menu row saved at once into the Evals tab's dataset — no dataset to choose, no expected
  // answer, and its confirmation in a menu that had just closed. It now opens the same form.
  const { createElement, createRef } = await import("react");
  const { markup } = await import("../lib/testRender.ts");
  const { SaveCaseControl } = await import("./composer/SaveCaseControl.tsx");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const props = { agentId: "liven", input: "Role: QA", connected: true };
  const onBar = markup(createElement(TooltipProvider, null, createElement(SaveCaseControl, props)));
  check(/aria-label="Save this test input as an eval case"/.test(onBar), "on the bar it is a button that opens the form");
  const fromMenu = markup(createElement(TooltipProvider, null, createElement(SaveCaseControl, {
    ...props, open: false, onOpenChange: () => {}, anchorRef: createRef<HTMLElement>(),
  })));
  check(!/aria-label="Save this test input as an eval case"/.test(fromMenu), "opened from the menu it has no button of its own, only the form");
  const { readFileSync } = await import("node:fs");
  const pane = readFileSync("src/components/BuildPane.tsx", "utf8");
  check(!/onSelect=\{promote\}/.test(pane) && /onSelect=\{\(\) => setSaveFromMenu\(true\)\}/.test(pane), "and the menu row opens it rather than saving");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

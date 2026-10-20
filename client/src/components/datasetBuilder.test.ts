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

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

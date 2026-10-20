// The run bar: the models chosen, the estimate, the ceiling, and what stands between a click and a bill.
//
//   npm run test:eval-run-bar

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

const { suggestedCeiling, parseCeiling, ceilingWarning } = await import("./EvalRunBar.tsx");
type Estimate = import("../types.ts").EvalEstimate;

const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  examples: 15, targets: 3, totalRuns: 45, judgeLowUsd: 0, judgeHighUsd: 0, hasUnpricedTarget: false, notes: [],
  totalLowUsd: 0.7093, totalHighUsd: 1.1821,
  perTarget: [
    { provider: "anthropic", model: "claude-sonnet-5", runs: 15, lowUsd: 0.1, highUsd: 0.2, basis: "measured", sampleSize: 5, priced: true },
    { provider: "anthropic", model: "claude-opus-5", runs: 15, lowUsd: 0.3, highUsd: 0.5, basis: "measured", sampleSize: 5, priced: true },
  ],
  ...over,
});

console.log("\nthe suggested ceiling is in cents, with no float error");
{
  // 0.2 × 1.5 is 0.30000000000000004 in dollars, and that is what the field showed.
  check(suggestedCeiling(0.2) === "0.30", `0.2 suggests $0.30 (${suggestedCeiling(0.2)})`);
  check(suggestedCeiling(0.0001) === "0.05", `a tiny estimate suggests the $0.05 floor (${suggestedCeiling(0.0001)})`);
  check(suggestedCeiling(1.1821) === "2.00", `$1.18 suggests a round $2.00 (${suggestedCeiling(1.1821)})`);
}

console.log("\na ceiling that is not one says why");
{
  check("error" in parseCeiling("0"), "0 is refused");
  check("error" in parseCeiling("-1"), "so is -1");
  check("error" in parseCeiling("abc"), "and abc");
  check("error" in parseCeiling("1e-9"), "and 1e-9, which used to be accepted");
  check("error" in parseCeiling(""), "and nothing");
  const ok = parseCeiling("$0.50");
  check("usd" in ok && ok.usd === 0.5, "while $0.50 is half a dollar");
}

console.log("\na ceiling too low for the estimate is said before Run");
{
  check(/below even the low end/.test(ceilingWarning(0.3, estimate()) ?? ""), "$0.30 against $0.71–$1.18 is below the low end");
  check(/less than one run/.test(ceilingWarning(0.01, estimate()) ?? ""), "a cent against a 3¢ run is less than one run");
  check(ceilingWarning(2, estimate()) === null, "and $2.00 is fine");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

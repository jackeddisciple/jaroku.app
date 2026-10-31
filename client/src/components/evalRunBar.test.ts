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

console.log("\nthe model chips, rendered");
{
  const { createElement } = await import("react");
  const { markup, seed } = await import("../lib/testRender.ts");
  const { useBuildStore } = await import("../store/buildStore.ts");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { useProviderStore } = await import("../store/providerStore.ts");
  const { EvalRunBar } = await import("./EvalRunBar.tsx");
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  seed(useBuildStore, { activeAgentId: "liven" } as never);
  seed(useProviderStore, {
    models: [
      { id: "claude-haiku-4-5", name: "Haiku 4.5", provider: "anthropic", label: "Anthropic" },
      { id: "claude-sonnet-5", name: "Sonnet 5", provider: "anthropic", label: "Anthropic" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", label: "OpenAI" },
      { id: "muse-spark-1.3", name: "Muse Spark 1.3", provider: "meta", label: "Meta" },
    ],
    providers: [
      { id: "anthropic", env_key: "ANTHROPIC_API_KEY", configured: true, runnable: true },
      { id: "openai", env_key: "OPENAI_API_KEY", configured: false, runnable: false },
      { id: "meta", env_key: "META_API_KEY", configured: false, runnable: false },
    ],
  } as never);
  seed(useEvalStore, {
    selectedDatasetByAgent: { liven: "d1" },
    examplesByDataset: { d1: [{ id: "x1", dataset_id: "d1", input: "a", expected: null, notes: null, position: 0, created_at: "" }] },
    targetsByAgent: { liven: [{ provider: "anthropic", model: "claude-sonnet-5" }] },
    progressByEval: {},
  } as never);
  let words = text(markup(createElement(EvalRunBar)));
  // THE CATALOGUE IS A MENU, grouped by provider; what the bar draws is the models chosen.
  const { modelGroups } = await import("./EvalRunBar.tsx");
  const { runProviders, useProviderStore: providers } = await import("../store/providerStore.ts");
  const { groups, missing } = modelGroups(runProviders(providers.getState().models), providers.getState().providers, [{ provider: "anthropic", model: "claude-sonnet-5" }]);
  check(groups.length === 1 && groups[0]!.label === "Anthropic" && groups[0]!.models.join() === "claude-haiku-4-5,claude-sonnet-5",
    "a provider's models sit under its name", JSON.stringify(groups));
  check(words.includes("Sonnet 5") && !words.includes("Haiku 4.5"), "and the bar draws the one chosen, not the whole catalogue", words);
  check(!words.includes("GPT-5.6 Luna") && !words.includes("Muse Spark") && !groups.some((g) => g.id !== "anthropic"),
    "models with no key are not drawn as greyed chips", words);
  const idle = markup(createElement(EvalRunBar));
  check(missing.count === 2 && words.includes("+2") && /title="Add a key for OpenAI, Meta in Secrets/.test(idle), "they are one link to Secrets instead", words);
  check(words.includes("1 × 1 = 1 run"), "the models chosen for this agent are the ones counted, from the store", words);
  check(/<button[^>]*title="Estimate the cost of this eval[^"]*"[^>]*>(?:(?!<\/button>).)*Estimate cost<\/button>/s.test(idle),
    "the tab's primary action is the filled button, saying what it does");
  check(!/text-run(?![a-z])/.test(idle), "and nothing on an idle run bar is amber — amber is for what is running");

  seed(useEvalStore, {
    progressByEval: { e1: { evalId: "e1", total: 1, done: 0, running: 1, queued: 0, failed: 0, agentId: "liven", startedHere: true } },
  } as never);
  const html = markup(createElement(EvalRunBar));
  check(/title="Locked while this eval runs/.test(html), "a chip locked by a running eval says so", html.match(/title="[^"]*"/g)?.slice(0, 2).join(" ") ?? "");
}

console.log("\nthe estimate says each model's share, and a refusal before Run");
{
  const { createElement } = await import("react");
  const { markup } = await import("../lib/testRender.ts");
  const { EstimateDetail } = await import("./EvalRunBar.tsx");
  const words = markup(createElement(EstimateDetail, {
    estimate: estimate({
      affordability: {
        ceilingUsd: 5, spentUsd: 5.2, spentIsComplete: true, headroomUsd: 0, availableCreditUsd: 0,
        wouldRefuse: true, refusalMessage: "This workspace has reached its $5.00 ceiling for the period.", mayNotFinish: true,
      },
    }),
  })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(words.includes("claude-opus-5") && words.includes("$0.3000") && words.includes("$0.5000"), "each model has its own range", words);
  check(words.includes("from 5 runs"), "and says what it was projected from", words);
  check(words.includes("reached its $5.00 ceiling"), "and a refusal is said before Run is pressed", words);
  // A workspace out of eval runs for the month was shown a clean estimate and refused only after Run.
  const { refusalOf } = await import("./EvalRunBar.tsx");
  const plan = "28 of 20 eval runs per month used on the free plan";
  check(refusalOf(estimate({ planRefusal: plan })) === plan, "the plan's refusal is said before Run too");
  check(refusalOf(estimate({ planRefusal: plan, affordability: {
    ceilingUsd: 5, spentUsd: 5.2, spentIsComplete: true, headroomUsd: 0, availableCreditUsd: 0,
    wouldRefuse: true, refusalMessage: "ceiling", mayNotFinish: true,
  } })) === plan, "and ahead of the budget's, since it refuses whatever the budget says");
  check(refusalOf(estimate({ planRefusal: null })) === null, "and nothing is refused when neither says so");
}

console.log("\nan agent that has never been built cannot be estimated or run");
{
  const { createElement } = await import("react");
  const { markup, seed } = await import("../lib/testRender.ts");
  const { useBuildStore } = await import("../store/buildStore.ts");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { EvalRunBar } = await import("./EvalRunBar.tsx");
  seed(useBuildStore, { activeAgentId: "bruno", agents: [{ agent_id: "bruno", name: "Bruno", draft: true }] } as never);
  seed(useEvalStore, {
    selectedDatasetByAgent: { bruno: "d9" },
    examplesByDataset: { d9: [{ id: "x1", dataset_id: "d9", input: "a", expected: null, notes: null, position: 0, created_at: "" }] },
    targetsByAgent: { bruno: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    progressByEval: {},
  } as never);
  const html = markup(createElement(EvalRunBar));
  check(html.includes("Build Bruno before running an eval on it"), "the bar says to build it first", html.replace(/<[^>]+>/g, " ").slice(0, 300));
  const button = (html.match(/<button[^>]*>/g) ?? []).find((b) => b.includes("Estimate the cost")) ?? "";
  check(/\sdisabled=""/.test(button), "and Estimate is off", button);
}

console.log("\na chosen model with effort levels can be given one");
{
  const { createElement } = await import("react");
  const { markup, seed } = await import("../lib/testRender.ts");
  const { useBuildStore } = await import("../store/buildStore.ts");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { useProviderStore } = await import("../store/providerStore.ts");
  const { EvalRunBar } = await import("./EvalRunBar.tsx");
  seed(useBuildStore, { activeAgentId: "liven", agents: [{ agent_id: "liven", name: "Liven" }] } as never);
  seed(useProviderStore, {
    models: [
      { id: "claude-sonnet-5", name: "Sonnet 5", provider: "anthropic", label: "Anthropic", reasoning: "effort", effort_levels: ["low", "medium", "high"] },
      { id: "claude-haiku-4-5", name: "Haiku 4.5", provider: "anthropic", label: "Anthropic", reasoning: null },
    ],
    providers: [{ id: "anthropic", env_key: "ANTHROPIC_API_KEY", configured: true, runnable: true }],
  } as never);
  seed(useEvalStore, {
    selectedDatasetByAgent: { liven: "d1" },
    examplesByDataset: { d1: [{ id: "x1", dataset_id: "d1", input: "a", expected: null, notes: null, position: 0, created_at: "" }] },
    targetsByAgent: { liven: [{ provider: "anthropic", model: "claude-sonnet-5", effort: "high" }, { provider: "anthropic", model: "claude-haiku-4-5" }] },
    progressByEval: {},
  } as never);
  const html = markup(createElement(EvalRunBar));
  const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(/aria-label="Reasoning effort for Sonnet 5"/.test(html), "Sonnet 5 gets an effort menu", words);
  check(!/aria-label="Reasoning effort for Haiku 4.5"/.test(html), "Haiku 4.5, which has no levels, does not");
  const { effortChoices } = await import("./EvalRunBar.tsx");
  const sonnet = useProviderStore.getState().models.find((m) => m.id === "claude-sonnet-5");
  const labels = effortChoices(sonnet).map((c) => c.label);
  check(words.includes("High") && labels[0] === "Default" && labels.includes("High") && labels.length === 4,
    "it says the level chosen, and offers Default and the model's own levels", `${words} | ${labels.join(", ")}`);
  check(effortChoices(useProviderStore.getState().models.find((m) => m.id === "claude-haiku-4-5")).length === 0, "and a model with none offers nothing");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

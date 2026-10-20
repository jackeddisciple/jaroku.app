// What the eval channel does to THIS tab, when the message was meant for another one.
//
// Every eval message goes to every socket in the workspace. That is right for state a client files
// under what it names — a dataset's cases, an eval's progress — and it was wrong for every answer:
// one person's estimate filled whichever confirm box another had open, their errors appeared in
// everybody's dataset view, their "saved to …" flashed in every composer, and an eval one person
// started switched every member's panel to it, where their Cancel would then cancel it.
//
// Driven through the real socket, with a fake WebSocket delivering the frames a server would send.
//
//   npm run test:eval-channel

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

class FakeSocket {
  // What `send` compares readyState against before it writes a frame.
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  close(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const kept = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => void kept.set(k, v),
  removeItem: (k: string) => void kept.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };
g["WebSocket"] = FakeSocket;
g["fetch"] = async (url: string): Promise<unknown> => {
  const path = new URL(url, "http://localhost").pathname;
  if (path === "/v1/auth/session") {
    return {
      ok: true,
      json: async () => ({
        user: { id: "u1", email: "a@b.c", displayName: "A", onboarded: true, onboardingStep: 5, isAdmin: false, adminMode: false },
        workspaces: [{ id: "ws-a", slug: "a", name: "Alpha", kind: "team", role: "owner", plan: { id: "free", label: "Free" } }],
        defaultWorkspaceId: "ws-a",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    };
  }
  if (path === "/v1/ws-ticket") return { ok: true, json: async () => ({ ticket: "t", workspaceId: "ws-a", role: "owner" }) };
  return { ok: true, json: async () => ({}) };
};

const { storeToken } = await import("./auth.ts");
const { useEvalStore } = await import("../store/evalStore.ts");
const { startSocket, stopSocket, EVAL_ORIGIN, sendEstimateEval } = await import("./socket.ts");

storeToken("a-token");
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
startSocket();
for (let i = 0; i < 20 && FakeSocket.all.length === 0; i++) await settle();
const socket = FakeSocket.all.at(-1)!;
socket.accept();
await settle();

const estimate = { examples: 3, targets: 1, totalRuns: 3, perTarget: [], judgeLowUsd: 0, judgeHighUsd: 0, totalLowUsd: 0.01, totalHighUsd: 0.02, hasUnpricedTarget: false, notes: [] };
const OTHER = "another-members-tab";

console.log("\na request carries this tab's name");
{
  sendEstimateEval("d1", "liven", [{ provider: "anthropic", model: "claude-haiku-4-5" }]);
  const sent = socket.sent.map((s) => JSON.parse(s) as { cmd?: string; origin?: string }).find((m) => m.cmd === "estimateEval");
  check(sent?.origin === EVAL_ORIGIN, `the estimate request names this tab (${sent?.origin})`);
}

console.log("\nanother tab's answers are not applied here");
{
  socket.deliver({ channel: "eval", type: "estimate", estimate, origin: OTHER });
  check(useEvalStore.getState().estimate === null, "another member's estimate does not fill this confirm box");
  socket.deliver({ channel: "eval", type: "error", message: "an eval is already running", origin: OTHER });
  check(useEvalStore.getState().error === null, "nor does their error appear here");
  socket.deliver({ channel: "eval", type: "promoted", datasetId: "d1", datasetName: "Theirs", duplicate: false, origin: OTHER });
  check(useEvalStore.getState().promoted === null, "nor their saved-to-dataset confirmation");
}

console.log("\nthis tab's answers are");
{
  socket.deliver({ channel: "eval", type: "estimate", estimate, origin: EVAL_ORIGIN });
  check(useEvalStore.getState().estimate?.totalRuns === 3, "its own estimate lands");
  socket.deliver({ channel: "eval", type: "error", message: "no", origin: EVAL_ORIGIN });
  check(useEvalStore.getState().error === "no", "and its own error");
}

console.log("\nan eval somebody else started is recorded, and does not take this panel");
{
  socket.deliver({ channel: "eval", type: "evalStarted", evalId: "e-theirs", datasetId: "d1", agentId: "liven", total: 4, targets: [], origin: OTHER });
  const st = useEvalStore.getState();
  check(st.progressByEval["e-theirs"]?.agentId === "liven", "its progress is filed under its agent");
  check(st.progressByEval["e-theirs"]?.startedHere === false, "as started elsewhere");
  check(st.selectedEvalByAgent["liven"] === undefined, "and this tab's selection is left where it was");
  socket.deliver({ channel: "eval", type: "evalStarted", evalId: "e-mine", datasetId: "d1", agentId: "bruno", total: 2, targets: [], origin: EVAL_ORIGIN });
  check(useEvalStore.getState().selectedEvalByAgent["bruno"] === "e-mine", "while this tab's own eval is selected for it");
}

console.log("\nstate a message names still reaches everybody");
{
  socket.deliver({ channel: "eval", type: "datasets", agentId: "liven", datasets: [{ id: "d1", agent_id: "liven", name: "Screening", created_at: "", updated_at: "" }] });
  check(useEvalStore.getState().datasetsByAgent["liven"]?.length === 1, "an agent's datasets are filed under it, whoever changed them");
  socket.deliver({ channel: "eval", type: "datasets", agentId: null, datasets: [] });
  check(useEvalStore.getState().datasetsByAgent["liven"]?.length === 1, "and a list naming no agent replaces nobody's");
}

console.log("\na dataset this tab created is selected, with its name open for editing");
{
  socket.deliver({ channel: "eval", type: "datasetCreated", datasetId: "d-new", agentId: "liven", origin: OTHER });
  check(useEvalStore.getState().renameRequest === null, "another member's new dataset does not open here");
  socket.deliver({ channel: "eval", type: "datasetCreated", datasetId: "d-new", agentId: "liven", origin: EVAL_ORIGIN });
  check(useEvalStore.getState().selectedDatasetByAgent["liven"] === "d-new", "this tab's is selected");
  check(useEvalStore.getState().renameRequest === "d-new", "and its name is offered for editing");
}

console.log("\na delete waits out its undo window before it is sent");
{
  const { deleteWithUndo, undoPendingDelete, flushPendingDelete } = await import("./evalUndo.ts");
  const sentCmds = (): string[] => socket.sent.map((f) => (JSON.parse(f) as { cmd?: string }).cmd ?? "");
  useEvalStore.getState().setDatasets("liven", [
    { id: "d-new", agent_id: "liven", name: "Test set 2", created_at: "", updated_at: "" },
    { id: "d1", agent_id: "liven", name: "Screening", created_at: "", updated_at: "" },
  ]);
  useEvalStore.getState().selectDataset("liven", "d-new");
  const before = sentCmds().length;
  deleteWithUndo({ kind: "dataset", id: "d-new", datasetId: "d-new", agentId: "liven", label: "Test set 2", cases: 15 });
  check(useEvalStore.getState().pendingDelete?.id === "d-new", "the dataset is pending, not deleted");
  check(!sentCmds().slice(before).includes("deleteDataset"), "nothing has been sent yet");
  check(useEvalStore.getState().selectedDatasetByAgent["liven"] === "d1", "and the selection moved to the next dataset");
  undoPendingDelete();
  check(useEvalStore.getState().pendingDelete === null && !sentCmds().slice(before).includes("deleteDataset"), "Undo puts it back, and nothing was ever sent");
  check(useEvalStore.getState().selectedDatasetByAgent["liven"] === "d-new", "with it selected again");

  deleteWithUndo({ kind: "case", id: "c1", datasetId: "d1", agentId: "liven", label: "Role: QA" });
  deleteWithUndo({ kind: "case", id: "c2", datasetId: "d1", agentId: "liven", label: "Role: SRE" });
  check(sentCmds().slice(before).filter((c) => c === "deleteExample").length === 1, "a second delete sends the first");
  flushPendingDelete();
  check(sentCmds().slice(before).filter((c) => c === "deleteExample").length === 2, "and the window closing sends the second");
}

stopSocket();
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

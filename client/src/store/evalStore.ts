// Eval state — datasets and their examples (doc §6.4 dataset builder).
//
// Deliberately separate from traceStore. The trace store owns run data and has one
// invariant that matters here: `applyEvent` focuses `activeRunId` on every run_start. An
// eval fans out into many parallel runs, so if eval data flowed through there the Trace
// timeline would jump between them and the user would lose their place. Eval facts arrive
// on their own channel and land here; the runs an eval produces are still ordinary runs,
// read back on demand through the existing loadRun path.
//
// The server answers every mutation with a full snapshot, so every reducer below is a
// replace, never a merge — there is no partial state to reconcile.
//
// KEYED BY AGENT, BY DATASET AND BY EVAL — never "the one on screen". The datasets, the selection,
// the eval history and the live progress were each a single global value, so selecting another
// agent while an eval ran showed that agent the first one's results, its cases and its
// `running 2/12`, with nothing on the panel to say whose they were. Every message names what it is
// about, and it lands under that name; a panel reads the agent it is showing.

import { create } from "zustand";
import type { Dataset, DatasetExample, EvalEstimate, EvalJudgeState, EvalResults, EvalRunSummary, EvalTarget, Rubric } from "../types.ts";

/** Live counters while an eval drains. Counts only — no step traffic on this channel. */
export interface EvalProgress {
  evalId: string;
  total: number;
  done: number;
  running: number;
  queued: number;
  failed: number;
  /** Of `done`, the jobs that ran and succeeded, and the ones that never ran. Absent until the first count. */
  succeeded?: number;
  cancelled?: number;
  /** Set once the runs finish; scoring may still be in flight. */
  status?: string;
  scoring?: boolean;
  /** Whose eval, from `evalStarted`. A count names only its eval, so these are kept from the start. */
  agentId?: string;
  datasetId?: string;
  /** Started from THIS tab. Only then does the panel switch to it — another member's eval does not. */
  startedHere?: boolean;
}

/** One eval history list, as the server answered it for one scope. */
export interface EvalList {
  evals: EvalRunSummary[];
  /** Whether the window reached the end of this scope's history. */
  complete: boolean;
  /** The window it was read with. */
  window: number;
}

/** An agent's history for one dataset, or — with no dataset — across all of its datasets. */
export function evalListKey(agentId: string, datasetId: string | null): string {
  return `${agentId}|${datasetId ?? "*"}`;
}

/** A dataset or case deleted from the list and not yet from the server — see lib/evalUndo.ts. */
export interface PendingDelete {
  kind: "dataset" | "case";
  /** The dataset's id, or the case's. */
  id: string;
  datasetId: string;
  agentId: string;
  /** What the toast calls it: a dataset's name, or the first words of a case. */
  label: string;
  /** For a dataset, how many cases go with it. */
  cases?: number;
  at: number;
}

interface EvalState {
  /** agent -> its datasets, newest first. */
  datasetsByAgent: Record<string, Dataset[]>;
  /** datasetId -> its examples, in position order. Populated on demand. */
  examplesByDataset: Record<string, DatasetExample[]>;
  /** agent -> which dataset the builder is showing for it. */
  selectedDatasetByAgent: Record<string, string | null>;
  /** Last control-plane error, surfaced inline rather than swallowed. */
  error: string | null;
  /** Transient confirmation for a one-click promotion — the composer shows it briefly so
   *  the user knows WHERE the input landed (and whether it was already there). */
  promoted: { datasetName: string; duplicate: boolean; at: number } | null;

  setDatasets: (agentId: string, datasets: Dataset[]) => void;
  setExamples: (datasetId: string, examples: DatasetExample[]) => void;
  removeDataset: (datasetId: string) => void;
  selectDataset: (agentId: string, id: string | null) => void;
  setError: (message: string | null) => void;
  setPromoted: (datasetName: string, duplicate: boolean) => void;
  clearPromoted: () => void;
  /**
   * A dataset this tab just created, whose name the builder should open for editing. A new dataset
   * used to appear as a chip to the left with the old one still selected and a numbered name.
   */
  renameRequest: string | null;
  requestRename: (datasetId: string | null) => void;
  /** A delete waiting out its undo window: hidden from the lists, not yet sent. */
  pendingDelete: PendingDelete | null;
  setPendingDelete: (d: PendingDelete | null) => void;
  /**
   * agent -> the models chosen to compare it on. The run bar's own state was lost every time it
   * remounted — switching Dataset and Results — and the choice went back to the composer's model.
   */
  targetsByAgent: Record<string, EvalTarget[]>;
  setTargets: (agentId: string, targets: EvalTarget[]) => void;
  /** Whether this workspace's evals are judged, once asked. Null until the server has said. */
  judge: EvalJudgeState | null;
  setJudge: (judge: EvalJudgeState) => void;
  /**
   * agent -> which half of the Evals tab it was on, and eval -> which cell was open. Both were the
   * panel's own state, so opening a cell's trace and coming back landed on Dataset with the cell shut.
   */
  modeByAgent: Record<string, "dataset" | "results">;
  setMode: (agentId: string, mode: "dataset" | "results") => void;
  openCellByEval: Record<string, string | null>;
  setOpenCell: (evalId: string, jobId: string | null) => void;
  /** An agent whose run bar should open its estimate — Run again's hand-off. Consumed by the bar. */
  estimateRequest: string | null;
  requestEstimate: (agentId: string | null) => void;

  // --- eval runs ---
  /** evalListKey(agent, dataset) -> that scope's history, newest first. */
  evalLists: Record<string, EvalList>;
  /** agent -> the eval whose results the dashboard is showing for it. */
  selectedEvalByAgent: Record<string, string | null>;
  /** evalId -> full results (provider rollups + per-example rows). */
  resultsByEval: Record<string, EvalResults>;
  /** evalId -> its live counters, while it drains and once it has finished. */
  progressByEval: Record<string, EvalProgress>;
  /** datasetId -> the rubric it scores against, once loaded. */
  rubricByDataset: Record<string, { rubric: Rubric; isDefault: boolean }>;

  /**
   * One scope's eval history, and how much of it has been asked for.
   *
   * A growing WINDOW rather than a page — see socket.sendListEvals.
   */
  setEvals: (key: string, evals: EvalRunSummary[], meta?: { complete?: boolean; window?: number }) => void;
  selectEval: (agentId: string, evalId: string | null) => void;
  setResults: (evalId: string, results: EvalResults) => void;
  /** An eval has started: its counters begin, filed under its agent and dataset. */
  noteStarted: (p: EvalProgress) => void;
  /**
   * A count from the server's `evalProgress`.
   *
   * A FINISHED EVAL STAYS FINISHED. `evalFinished` sets `status`, and a count that arrives after it
   * — two jobs exiting together each sent one — used to replace the whole object and take the status
   * with it, so a finished eval read `running 15/15` with a Cancel that could cancel nothing and
   * every model chip locked until a reload.
   */
  applyProgress: (p: EvalProgress) => void;
  patchProgress: (evalId: string, patch: Partial<EvalProgress>) => void;
  setRubric: (datasetId: string, rubric: Rubric, isDefault: boolean) => void;

  /** Pre-run cost estimate for the currently selected targets, once requested. */
  estimate: EvalEstimate | null;
  setEstimate: (e: EvalEstimate | null) => void;
}

export const useEvalStore = create<EvalState>((set) => ({
  datasetsByAgent: {},
  examplesByDataset: {},
  selectedDatasetByAgent: {},
  error: null,
  promoted: null,

  setDatasets: (agentId, datasets) =>
    set((s) => {
      // Keep a selection only while it still exists; otherwise fall back to the newest so the
      // builder is never pointed at a dataset that has been deleted elsewhere.
      const current = s.selectedDatasetByAgent[agentId];
      const kept = current && datasets.some((d) => d.id === current) ? current : (datasets[0]?.id ?? null);
      return {
        datasetsByAgent: { ...s.datasetsByAgent, [agentId]: datasets },
        selectedDatasetByAgent: { ...s.selectedDatasetByAgent, [agentId]: kept },
      };
    }),

  setExamples: (datasetId, examples) =>
    set((s) => ({ examplesByDataset: { ...s.examplesByDataset, [datasetId]: examples } })),

  removeDataset: (datasetId) =>
    set((s) => {
      const examplesByDataset = { ...s.examplesByDataset };
      delete examplesByDataset[datasetId];
      const datasetsByAgent: Record<string, Dataset[]> = {};
      for (const [agent, list] of Object.entries(s.datasetsByAgent)) datasetsByAgent[agent] = list.filter((d) => d.id !== datasetId);
      const selectedDatasetByAgent: Record<string, string | null> = {};
      for (const [agent, id] of Object.entries(s.selectedDatasetByAgent)) {
        selectedDatasetByAgent[agent] = id === datasetId ? (datasetsByAgent[agent]?.[0]?.id ?? null) : id;
      }
      return { examplesByDataset, datasetsByAgent, selectedDatasetByAgent };
    }),

  selectDataset: (agentId, id) =>
    set((s) => ({ selectedDatasetByAgent: { ...s.selectedDatasetByAgent, [agentId]: id }, error: null })),

  setError: (error) => set({ error }),

  setPromoted: (datasetName, duplicate) => set({ promoted: { datasetName, duplicate, at: Date.now() } }),
  clearPromoted: () => set({ promoted: null }),

  renameRequest: null,
  requestRename: (renameRequest) => set({ renameRequest }),

  pendingDelete: null,
  setPendingDelete: (pendingDelete) => set({ pendingDelete }),

  targetsByAgent: {},
  setTargets: (agentId, targets) => set((s) => ({ targetsByAgent: { ...s.targetsByAgent, [agentId]: targets } })),

  judge: null,
  setJudge: (judge) => set({ judge }),

  modeByAgent: {},
  setMode: (agentId, mode) => set((s) => ({ modeByAgent: { ...s.modeByAgent, [agentId]: mode } })),
  openCellByEval: {},
  setOpenCell: (evalId, jobId) => set((s) => ({ openCellByEval: { ...s.openCellByEval, [evalId]: jobId } })),
  estimateRequest: null,
  requestEstimate: (estimateRequest) => set({ estimateRequest }),

  evalLists: {},
  selectedEvalByAgent: {},
  resultsByEval: {},
  progressByEval: {},
  rubricByDataset: {},

  setEvals: (key, evals, meta) =>
    set((s) => {
      const before = s.evalLists[key];
      return {
        evalLists: {
          ...s.evalLists,
          [key]: {
            evals,
            complete: meta?.complete ?? before?.complete ?? true,
            window: meta?.window ?? before?.window ?? 50,
          },
        },
      };
    }),

  selectEval: (agentId, evalId) =>
    set((s) => ({ selectedEvalByAgent: { ...s.selectedEvalByAgent, [agentId]: evalId } })),

  setResults: (evalId, results) =>
    set((s) => ({ resultsByEval: { ...s.resultsByEval, [evalId]: results } })),

  noteStarted: (p) => set((s) => ({ progressByEval: { ...s.progressByEval, [p.evalId]: { ...p } } })),

  applyProgress: (p) =>
    set((s) => {
      const before = s.progressByEval[p.evalId];
      if (before?.status !== undefined) return {};
      return {
        progressByEval: {
          ...s.progressByEval,
          [p.evalId]: {
            ...p,
            agentId: p.agentId ?? before?.agentId,
            datasetId: p.datasetId ?? before?.datasetId,
            startedHere: p.startedHere ?? before?.startedHere,
          },
        },
      };
    }),

  patchProgress: (evalId, patch) =>
    set((s) => {
      const before = s.progressByEval[evalId];
      return before ? { progressByEval: { ...s.progressByEval, [evalId]: { ...before, ...patch } } } : {};
    }),

  setRubric: (datasetId, rubric, isDefault) =>
    set((s) => ({ rubricByDataset: { ...s.rubricByDataset, [datasetId]: { rubric, isDefault } } })),

  estimate: null,
  setEstimate: (estimate) => set({ estimate }),
}));

/** Examples of a dataset in position order. `[]` when not loaded yet. */
export function examplesOf(
  byDataset: Record<string, DatasetExample[]>,
  datasetId: string | null,
): DatasetExample[] {
  if (!datasetId) return [];
  return byDataset[datasetId] ?? [];
}

/** One agent's datasets, newest first. `[]` until they are listed. */
export function datasetsOf(byAgent: Record<string, Dataset[]>, agentId: string | null): Dataset[] {
  return agentId ? (byAgent[agentId] ?? []) : [];
}

/**
 * The eval of this agent that is still going — running, or finished and still being scored — or
 * null. Its own agent's, never another's: a different agent's eval is not this panel's to show.
 */
export function liveEvalOf(byEval: Record<string, EvalProgress>, agentId: string | null): EvalProgress | null {
  if (!agentId) return null;
  for (const p of Object.values(byEval)) {
    if (p.agentId === agentId && (p.status === undefined || p.scoring === true)) return p;
  }
  return null;
}

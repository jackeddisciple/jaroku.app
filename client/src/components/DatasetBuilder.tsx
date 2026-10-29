// Dataset builder — the Evals tab's first surface (doc §6.4: "manual entries, CSV import,
// promote test input to dataset").
//
// A dataset is a list of agent inputs. That's the whole primitive: an eval runs the agent
// over each input on every selected provider, and the judge scores what comes back. Ground
// truth (`expected`) is optional — a dataset of inputs with no expected output is still a
// perfectly good comparison, because the judge scores against the rubric, not a diff.
//
// Every mutation goes over the eval channel and comes back as a full snapshot, so nothing
// here keeps optimistic local state; the only local state is which row is being edited.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { datasetsOf, examplesOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import {
  sendAddExample,
  sendAddExamples,
  sendCreateDataset,
  sendLoadDataset,
  sendLoadRubric,
  sendRenameDataset,
  sendResetRubric,
  sendSaveRubric,
  sendSetDatasetCheck,
  sendDuplicateDataset,
  sendUpdateExample,
} from "../lib/socket.ts";
import { csvToExamples } from "../lib/csv.ts";
import { deleteWithUndo } from "../lib/evalUndo.ts";
import { download, examplesToCsv } from "../lib/evalExport.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { SectionHeader } from "./SectionHeader.tsx";
import { DatabaseIcon, XIcon } from "./panelIcons.tsx";
import { iconBtn, markBtn, primaryBtnSm, textBtn } from "./buttons.ts";
import type { Dataset, DatasetExample, RubricCriterion } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";

/** The trace's grey mark, for the one action on a dataset that removes it: red on approach. */
const DANGER_MARK = markBtn.replace("hover:text-ink", "hover:text-err");

/** An input/expected pair, editable in place. Commits on blur; Escape reverts. */
function ExampleRow({
  example,
  index,
  datasetId,
  agentId,
}: {
  example: DatasetExample;
  index: number;
  datasetId: string;
  agentId: string;
}) {
  const [editing, setEditing] = useState<null | "input" | "expected" | "notes">(null);
  /** A long case folds to a few lines; this unfolds it. A Liven case is a job and a résumé. */
  const [unfolded, setUnfolded] = useState(false);
  const [draft, setDraft] = useState("");
  /** Why the edit cannot be saved as it stands — said, rather than quietly putting the old text back. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const begin = (field: "input" | "expected" | "notes") => {
    setDraft(field === "input" ? example.input : field === "expected" ? (example.expected ?? "") : (example.notes ?? ""));
    setRefusal(null);
    setEditing(field);
  };

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const commit = (leaving = false) => {
    if (!editing) return;
    const value = draft.trim();
    // An empty input would be a run with nothing to do. Pressing Enter on one used to put the old
    // text back without a word; now it says why, and stays open until it is fixed or Escaped. Leaving
    // the field (a blur) still keeps the old text, because a click elsewhere is not a decision.
    if (editing === "input" && !value) {
      if (leaving) { setEditing(null); setRefusal(null); }
      else setRefusal("A case needs an input — Escape keeps the old one.");
      return;
    }
    const unchanged =
      editing === "input" ? value === example.input
        : editing === "expected" ? value === (example.expected ?? "")
          : value === (example.notes ?? "");
    if (!unchanged) {
      sendUpdateExample(datasetId, example.id,
        editing === "input" ? { input: value } : editing === "expected" ? { expected: value || null } : { notes: value || null });
    }
    setRefusal(null);
    setEditing(null);
  };

  const long = example.input.split("\n").length > 4 || example.input.length > 360;
  const field = (which: "input" | "expected" | "notes", text: string, placeholder: string) =>
    editing === which ? (
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); setRefusal(null); setEditing(null); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
        }}
        rows={Math.min(draft.split("\n").length + 1, 6)}
        // An input and an expected output are compared character for character: no smart dashes or quotes.
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="w-full resize-none bg-elevated text-ink rounded-input border border-edge px-2 py-1 text-caption outline-none focus:shadow-focusring"
      />
    ) : (
      // `block`: WEBKIT SIZES A BUTTON FROM ITS CONTENT'S FULL HEIGHT, folded or not — so a folded
      // case kept the unfolded case's height as a blank block under it, in the desktop app and Safari.
      <button
        type="button"
        onClick={() => begin(which)}
        title="Click to edit"
        className={`block w-full text-left text-caption rounded-control px-2 py-1 -mx-2 hover:bg-active/50 transition-colors whitespace-pre-wrap break-words ${
          text ? (which === "input" ? "text-ink" : "text-muted") : "text-faint italic"
        }${
          // THE TWO INVITATIONS WAIT FOR THE CASE TO BE REACHED FOR. "+ expected output" and "+ note"
          // under every case made a list of fifty cases three lines of grey per case. They leave the
          // layout until the row is hovered or anything in it has focus — Tab onto the case and they
          // are there, next in order — rather than keeping an invisible line's height under every case.
          !text && which !== "input" ? " hidden group-hover:block group-focus-within:block" : ""
        }`}
      >
        {/* FOLDED WHEN LONG. Unfolded, one case filled the panel and the others were a scroll away. */}
        <span
          className={which === "input" && long && !unfolded ? "clamp-lines" : "block"}
          style={which === "input" && long && !unfolded ? ({ "--clamp": 4 } as CSSProperties) : undefined}
        >
          {/* WHAT A SECOND LINE IS, said — an expected output and a note were the same grey text. */}
          {text && which !== "input" && (
            <span className={`mr-1.5 not-italic ${TYPE.sectionLabel}`}>{which === "expected" ? "Expected" : "Note"}</span>
          )}
          {text || placeholder}
        </span>
      </button>
    );

  return (
    <div className="group flex gap-3 px-3 py-2.5">
      <span className="text-faint text-tiny tabular-nums pt-1 w-6 shrink-0 text-right select-none">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        {field("input", example.input, "(empty)")}
        {long && editing !== "input" && (
          <button onClick={() => setUnfolded((v) => !v)} className="px-2 text-tiny text-faint transition-colors hover:text-ink">
            {unfolded ? "show less" : "show more"}
          </button>
        )}
        {refusal && <div className="px-2 text-tiny text-err" role="alert">{refusal}</div>}
        {field("expected", example.expected ?? "", "+ expected output (optional)")}
        {/* NOTES, which the schema and the API carried and the tab never showed. For the person who
            wrote the case — why it is here, what it tests — and never sent to the agent or the judge. */}
        {field("notes", example.notes ?? "", "+ note")}
      </div>
      {/* SEEN BY A KEYBOARD, AND ONLY ITS OWN SIZE. It was invisible to Tab and stretched down the
          case's whole right edge — 242px on a long case — so a stray click there deleted the case. It
          shows on focus as on hover, sits at the top of the row, and a delete can be undone. */}
      <button
        type="button"
        onClick={() => deleteWithUndo({
          kind: "case", id: example.id, datasetId, agentId,
          label: example.input.split("\n")[0]!.slice(0, 40),
        })}
        title="Remove this case"
        aria-label={`Remove case ${index + 1}`}
        className="self-start mt-1 shrink-0 rounded-control text-faint opacity-0 transition-opacity hover:text-err group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <XIcon size={ICON.xs} />
      </button>
    </div>
  );
}

/**
 * The rubric the judge scores against — §6.4's "editable rubric", finally editable.
 *
 * WHAT WAS MISSING WAS ONLY THIS. `rubrics` is a table, `loadRubric` and `saveRubric` are commands
 * with capability entries, the store has `rubric` / `rubricIsDefault` / `setRubric`, both senders
 * exist, and `EvalDrillDown` already renders per-criterion score breakdowns. No component read the
 * state and neither sender was ever called — so every eval in the product scored against the
 * built-in rubric, and the server validated two user errors ("a rubric needs at least one
 * criterion", "…with weight above zero") that no user could produce. ADR-012 is titled *with a
 * data-driven rubric*; the data was not user-supplied anywhere.
 *
 * IT LIVES BESIDE THE EXAMPLES, in the dataset builder, because a rubric is dataset-scoped: saving
 * one writes a row against THIS dataset and never touches the shared default. "Correct" for a refund
 * bot is not "correct" for a SQL agent, which is the whole reason the table exists.
 *
 * EDITED AS A DRAFT, saved in one command. Every other mutation in this panel is a full-snapshot
 * round trip per keystroke-ish action, and that is right for an example — one row, one meaning. A
 * rubric is one object whose parts only make sense together: a half-saved rubric is a scoring
 * standard nobody chose, and it would be applied to the next eval.
 */
/** A criterion as it is being typed: the weight is the text in its field until it is saved. */
type DraftCriterion = Omit<RubricCriterion, "weight"> & { weight: string };

/** A weight field's text, as a weight — or null when it is not one. */
export function parseWeight(text: string): number | null {
  const t = text.trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * The next criterion's id: one past the highest `criterion_N` there is, never one in use.
 *
 * FROM THE COUNT IT REPEATED. Add two, remove the first, add another, and there were two
 * `criterion_5`s — and verdicts are kept by id, so their scores collapsed into one.
 */
export function nextCriterionId(criteria: readonly { id: string }[]): string {
  const taken = new Set(criteria.map((c) => c.id));
  let n = criteria.reduce((max, c) => Math.max(max, Number(/^criterion_(\d+)$/.exec(c.id)?.[1] ?? 0)), 0) + 1;
  while (taken.has(`criterion_${n}`)) n++;
  return `criterion_${n}`;
}

/** The first thing wrong with a draft, in the words the server would use — or null. Mirrors validateRubric. */
export function rubricProblem(criteria: readonly DraftCriterion[]): string | null {
  if (criteria.length === 0) return "a rubric needs at least one criterion";
  const seen = new Set<string>();
  for (const [i, c] of criteria.entries()) {
    if (seen.has(c.id)) return `two criteria share the id ${c.id}`;
    seen.add(c.id);
    const name = c.label.trim();
    if (!name) return `criterion ${i + 1} needs a name`;
    if (!c.description.trim()) return `"${name}" needs a description — it is what the judge is asked`;
    if (parseWeight(c.weight) === null) return `"${name}"'s weight must be a number from 0 to 100`;
  }
  if (!criteria.some((c) => (parseWeight(c.weight) ?? 0) > 0)) return "a rubric needs at least one criterion with weight above zero";
  return null;
}

/**
 * The rubric the judge scores against — §6.4's "editable rubric", finally editable.
 *
 * WHAT WAS MISSING WAS ONLY THIS. `rubrics` is a table, `loadRubric` and `saveRubric` are commands
 * with capability entries, the store has the state, both senders exist, and `EvalDrillDown` already
 * renders per-criterion score breakdowns. No component read the state and neither sender was ever
 * called — so every eval in the product scored against the built-in rubric. ADR-012 is titled *with a
 * data-driven rubric*; the data was not user-supplied anywhere.
 *
 * IT LIVES BESIDE THE EXAMPLES, in the dataset builder, because a rubric is dataset-scoped: saving
 * one writes a row against THIS dataset and never touches the shared default. "Correct" for a refund
 * bot is not "correct" for a SQL agent, which is the whole reason the table exists.
 *
 * EDITED AS A DRAFT, saved in one command — and the draft is THIS DATASET'S. The editor is keyed by
 * its dataset where it is mounted, so switching datasets with criteria half-added no longer carried
 * them over, under another dataset's name, with Save ready to write them there.
 */
function RubricEditor({ datasetId }: { datasetId: string }) {
  const loaded = useEvalStore((s) => s.rubricByDataset[datasetId]);
  const rubric = loaded?.rubric ?? null;
  const isDefault = loaded?.isDefault ?? true;
  const connected = useTraceStore((s) => s.connection === "open");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftCriterion[] | null>(null);

  // Loaded with the dataset, so the line above the cases says how many criteria there really are —
  // it read "0 criteria" for a rubric nobody had opened yet.
  useEffect(() => {
    if (connected) sendLoadRubric(datasetId);
  }, [connected, datasetId]);

  // The draft starts as whatever the server last said — which for a dataset with no rubric of its
  // own is the BUILT-IN one, so editing starts from the real criteria rather than from an empty
  // list somebody has to reinvent.
  const saved: DraftCriterion[] = (rubric?.criteria ?? []).map((c) => ({ ...c, weight: String(c.weight) }));
  const criteria = draft ?? saved;
  const dirty = draft !== null;
  const problem = dirty ? rubricProblem(criteria) : null;
  const total = criteria.reduce((sum, c) => sum + (parseWeight(c.weight) ?? 0), 0);

  const edit = (index: number, patch: Partial<DraftCriterion>): void => {
    setDraft(criteria.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const save = (): void => {
    if (rubricProblem(criteria)) return;
    sendSaveRubric(datasetId, criteria.map((c) => ({ ...c, weight: parseWeight(c.weight) ?? 0 })));
    setDraft(null);
  };

  return (
    <div className="border-t border-hair px-3 pb-2">
      {/* FOLDED AS THE TRACE FOLDS A SECTION: the chevron, the section's word, and one line saying what
          is in it — so the rubric reads as part of the dataset rather than as a strip of chrome. */}
      <button
        type="button"
        className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-control py-1.5 text-left focus-visible:outline-none focus-visible:shadow-focusring"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden className={`shrink-0 text-faint transition-transform duration-fast ${open ? "" : "-rotate-90"}`}>
          <Icon.trace.fold size={ICON.xs} />
        </span>
        <span className={`${TYPE.sectionLabel} shrink-0`}>Judge rubric</span>
        <span className="min-w-0 flex-1 truncate text-caption text-ink">
          {!loaded ? "loading…" : `${isDefault ? "Built-in" : "Custom"} · ${(rubric?.criteria ?? []).length} criteria`}
          {dirty && " · unsaved changes"}
        </span>
        {/* THE DISCLOSURE IS THE EDIT — opening this is how a rubric gets changed, so the mark
            goes here rather than on a second control that would do the same thing. */}
        <Icon.evals.editRubric size={ICON.xs} className="shrink-0 text-faint" />
      </button>

      {open && (
        // ITS OWN SCROLL AREA. It could not shrink, so five criteria pushed the case list to nothing and
        // drew the add field over the model chips.
        <div className="max-h-[40vh] space-y-2 overflow-y-auto pb-1">
          <p className="text-tiny leading-[1.55] text-faint">
            Each criterion is scored 0–4 against shared anchors and combined by weight; weights are
            normalised, so they do not have to add up. Saving writes a rubric for{" "}
            <span className="text-muted">this dataset only</span> and never changes the built-in one.
          </p>
          {criteria.map((c, i) => (
            <div key={`${c.id}-${i}`} className="rounded-control border border-hair px-2 py-1.5">
              <div className="flex items-center gap-2">
                <input
                  value={c.label}
                  onChange={(e) => edit(i, { label: e.target.value })}
                  placeholder="name"
                  aria-label={`Criterion ${i + 1} name`}
                  className="min-w-0 flex-1 rounded-input border border-edge bg-elevated px-2 py-1 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring"
                />
                {/* THE ID IS NOT EDITABLE ONCE IT EXISTS. It is what a stored verdict's
                    per-criterion score is keyed by, so renaming it would orphan every score
                    already recorded against this dataset — the drill-down would show a column of
                    blanks beside a criterion that looks identical. The label is the display name
                    and is free to change. */}
                <span className="shrink-0 text-tiny text-faint" title="the key stored verdicts are recorded against">
                  {c.id}
                </span>
                {/* THE TEXT AS TYPED, not a number re-rendered from it. `Number("0.")` is 0, so the
                    point vanished as it was typed and "0.25" became "25" — a criterion that then
                    outweighed every other one 125 to 1. */}
                <input
                  value={c.weight}
                  onChange={(e) => edit(i, { weight: e.target.value })}
                  inputMode="decimal"
                  aria-label={`Criterion ${i + 1} weight`}
                  title="Relative weight, 0 to 100"
                  aria-invalid={parseWeight(c.weight) === null}
                  className={`w-14 shrink-0 rounded-input border bg-elevated px-1.5 py-1 text-tiny text-ink outline-none focus-visible:shadow-focusring ${
                    parseWeight(c.weight) === null ? "border-err" : "border-edge"
                  }`}
                />
                <button
                  onClick={() => setDraft(criteria.filter((_, j) => j !== i))}
                  title="Remove this criterion"
                  aria-label={`Remove criterion ${i + 1}`}
                  className="shrink-0 text-faint transition-colors hover:text-err"
                >
                  <XIcon size={ICON.xs} />
                </button>
              </div>
              <textarea
                value={c.description}
                onChange={(e) => edit(i, { description: e.target.value })}
                // Grows with what it holds, so a sentence is not cut at the second line.
                rows={Math.min(8, Math.max(2, Math.ceil(c.description.length / 70) + c.description.split("\n").length - 1))}
                placeholder="what the judge should look for, phrased so a higher score is better"
                aria-label={`Criterion ${i + 1} description`}
                className="mt-1 w-full resize-none rounded-input border border-edge bg-elevated px-2 py-1 text-tiny leading-[1.5] text-muted placeholder:text-faint outline-none focus-visible:shadow-focusring"
              />
            </div>
          ))}

          {problem && <div className="text-tiny text-err">{problem}</div>}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={textBtn}
              onClick={() =>
                setDraft([
                  ...criteria,
                  // A NEW ID, never one in use. It has to be stable and it has to be a key, and
                  // deriving it from prose would change every time somebody edited the name — which
                  // is exactly what must not happen to the field verdicts are recorded against.
                  { id: nextCriterionId(criteria), label: "", description: "", weight: "0.1" },
                ])
              }
            >
              + Criterion
            </button>
            <span className="text-tiny text-faint">weights total {total.toFixed(2)}</span>
            {/* BACK TO THE BUILT-IN RUBRIC. A saved custom rubric could only ever be edited. Past evals
                keep the criteria they were scored on, so this changes the next eval only. */}
            {!isDefault && !dirty && (
              <button
                type="button"
                onClick={() => sendResetRubric(datasetId)}
                disabled={!connected}
                title="Score this dataset against the built-in rubric again. Past evals keep theirs."
                className={textBtn}
              >
                Reset to built-in
              </button>
            )}
            {/* SAVING IS THE DECISION THE EDITOR EXISTS TO ASK, so it is the one filled button. */}
            <button
              type="button"
              onClick={save}
              disabled={!connected || !dirty || problem !== null}
              title={!connected ? "Not connected" : problem ?? (dirty ? "Save this rubric for this dataset" : "Nothing to save")}
              className={`${primaryBtnSm} ml-auto`}
            >
              {dirty ? "Save rubric" : "Saved"}
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(null)}
                title="Revert to the saved rubric"
                aria-label="Revert to the saved rubric"
                className={iconBtn}
              >
                <Icon.evals.revertRubric size={ICON.xs} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The ways an answer can be checked against a case's expected output, as the server names them. */
export const CHECKS: { mode: string | null; label: string; hint: string }[] = [
  { mode: null, label: "Off", hint: "Expected outputs are only shown to the judge" },
  { mode: "exact", label: "Exact", hint: "The answer is the expected output — case and spacing aside" },
  { mode: "contains", label: "Contains", hint: "The answer contains the expected output" },
  { mode: "word", label: "Word", hint: "The answer says the expected word — decline, advance — as a whole word" },
  { mode: "regex", label: "Pattern", hint: "The expected output is a pattern the answer must match" },
];

/**
 * How this dataset's answers are checked against what each case expected — with no judge needed.
 *
 * `expected` was only ever shown to the judge, so without one it did nothing. Kept with each eval
 * when it starts, so changing it here grades the next eval and leaves past ones as they were.
 */
function CheckRow({ dataset }: { dataset: Dataset }) {
  const connected = useTraceStore((s) => s.connection === "open");
  const current = dataset.check_mode ?? null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2 text-tiny" role="group" aria-label="Check answers against expected">
      <span className="mr-1 text-muted">Check answers against expected</span>
      {CHECKS.map((c) => (
        <Chip
          key={c.label}
          size="sm"
          selected={current === c.mode}
          disabled={!connected}
          title={c.hint}
          onClick={() => current !== c.mode && sendSetDatasetCheck(dataset.id, c.mode)}
        >
          {c.label}
        </Chip>
      ))}
    </div>
  );
}

export function DatasetBuilder() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");

  // This agent's datasets and selection — another agent's are kept under its own name.
  const pendingDelete = useEvalStore((s) => s.pendingDelete);
  // A delete waiting out its undo window is gone from the lists already; only the server has it yet.
  const datasets = useEvalStore((s) => datasetsOf(s.datasetsByAgent, activeAgentId)).filter(
    (d) => !(pendingDelete?.kind === "dataset" && pendingDelete.id === d.id),
  );
  const examplesByDataset = useEvalStore((s) => s.examplesByDataset);
  const selectedDatasetId = useEvalStore((s) => (activeAgentId ? (s.selectedDatasetByAgent[activeAgentId] ?? null) : null));
  const selectDataset = useEvalStore((s) => s.selectDataset);
  const error = useEvalStore((s) => s.error);
  const setError = useEvalStore((s) => s.setError);

  const [newInput, setNewInput] = useState("");
  /** The new case's expected output while it is being typed, or null when its field is not open. */
  const [newExpected, setNewExpected] = useState<string | null>(null);
  /** What the case list is narrowed to. Cases are long, and there can be many. */
  const [query, setQuery] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  /**
   * The dataset's new name while it is being typed, or null when nobody is renaming.
   *
   * A FIELD IN THE ROW, NOT `window.prompt`. The desktop webview shows no JavaScript dialogs —
   * `prompt()` returns null there without asking — so Rename did nothing in the desktop app.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Why the rename was not sent — a blank name used to close the field and do nothing. */
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameRequest = useEvalStore((s) => s.renameRequest);
  const requestRename = useEvalStore((s) => s.requestRename);
  const fileRef = useRef<HTMLInputElement>(null);
  const examples = examplesOf(examplesByDataset, selectedDatasetId).filter(
    (e) => !(pendingDelete?.kind === "case" && pendingDelete.id === e.id),
  );
  const selected = datasets.find((d) => d.id === selectedDatasetId);
  const needle = query.trim().toLowerCase();
  const shownCases = examples
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !needle || [e.input, e.expected ?? "", e.notes ?? ""].some((t) => t.toLowerCase().includes(needle)));
  // A half-typed rename belongs to the dataset it was started on, not to the next one picked — and so
  // does the note about an import, which stayed across every switch until somebody dismissed it.
  useEffect(() => { setRenaming(null); setRenameError(null); setImportNote(null); setQuery(""); }, [selectedDatasetId]);
  // A dataset this tab just created opens with its name ready to edit.
  useEffect(() => {
    if (renameRequest && selected?.id === renameRequest) {
      setRenaming(selected.name);
      requestRename(null);
    }
  }, [renameRequest, selected?.id]);

  // Datasets are per-agent; re-list whenever the agent (or the connection) changes.
  // The agent's datasets are asked for by EvalsPanel, whichever half is open.

  // Examples load on demand — a dataset list shouldn't drag every example over the wire.
  useEffect(() => {
    if (connected && selectedDatasetId) sendLoadDataset(selectedDatasetId);
  }, [connected, selectedDatasetId]);


  const addExample = () => {
    const input = newInput.trim();
    if (!input || !selectedDatasetId) return;
    sendAddExample(selectedDatasetId, input, newExpected?.trim() || null);
    setNewInput("");
    setNewExpected(null);
  };

  const importCsv = async (file: File) => {
    const { examples: rows, warnings } = csvToExamples(await file.text());
    if (!selectedDatasetId) return;
    // ONE COMMAND, NOT ONE PER ROW. Rows sent separately were written concurrently, took the same
    // positions and came back scrambled; the batch is written in the file's order.
    if (rows.length) sendAddExamples(selectedDatasetId, rows.map((r) => ({ input: r.input, expected: r.expected })));
    setImportNote(
      rows.length
        ? `imported ${rows.length} example${rows.length === 1 ? "" : "s"}${warnings.length ? ` · ${warnings.join("; ")}` : ""}`
        : `nothing imported${warnings.length ? ` — ${warnings.join("; ")}` : ""}`,
    );
  };

  if (!activeAgentId) {
    return (
      <EmptyState
        icon={DatabaseIcon}
        title="No agent selected"
        hint="Pick one in the sidebar to build it a dataset."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* datasets */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-hair px-6 pb-2 pt-2">
        {/* IN THE STRIP, for the reason the MCP panel's is: this is a wrapping row of chips rather
            than a list with a heading over it. `listDatasets` answers with all of an agent's, so
            the length is a total. */}
        <SectionHeader name="Datasets" count={datasets.length} className="mr-1" />
        {datasets.map((d) => (
          <Chip
            key={d.id}
            size="lg"
            onClick={() => selectDataset(activeAgentId, d.id)}
            selected={d.id === selectedDatasetId}
            title={d.name}
            // Names come from agent names, which are generated from prompts and can be long.
            // Truncate so one dataset can't push the row into a second line.
            className="max-w-[220px]"
            figure={d.example_count ?? 0}
          >
            <Truncate>{d.name}</Truncate>
          </Chip>
        ))}
        <button
          // NO NAME: the server picks one this agent does not have. Numbering from the count here gave
          // two "Test set 3"s after a delete. Agent names are not used — they are generated from prompts
          // and run long, and the agent is already established by the sidebar.
          type="button"
          onClick={() => sendCreateDataset(activeAgentId)}
          disabled={!connected}
          className={`${textBtn} shrink-0`}
        >
          + New dataset
        </button>
      </div>

      {selected && (
        /* THE DENSEST TEXT-BUTTON CLUSTER IN THE APP, as a glyph row. Five words-as-buttons in
            one strip — Rename, Import CSV, Delete dataset, plus Revert and Add nearby — read as a
            form toolbar rather than as the actions on a dataset. Every mark here already existed
            in the icon set; the words are the tooltips. DRAWN AS THE TRACE'S RUN ACTIONS ARE — marks
            on a grey ground (`markBtn`) — with Delete set apart at the row's end. */
        <div className="flex shrink-0 items-center gap-1 px-6 py-2">
          {renaming !== null ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = renaming.trim();
                if (!name) { setRenameError("A dataset needs a name."); return; }
                if (name.length > 80) { setRenameError("A dataset name can be at most 80 characters."); return; }
                if (name !== selected.name) sendRenameDataset(selected.id, name);
                setRenameError(null);
                setRenaming(null);
              }}
            >
              <input
                value={renaming}
                onChange={(e) => { setRenaming(e.target.value); setRenameError(null); }}
                aria-invalid={renameError !== null}
                title={renameError ?? undefined}
                onKeyDown={(e) => {
                  // The panel's own keys must not fire from a field somebody is typing a name into.
                  e.stopPropagation();
                  if (e.key === "Escape") { setRenaming(null); setRenameError(null); }
                }}
                autoFocus
                aria-label="Dataset name"
                className="min-w-0 flex-1 rounded-input border border-edge bg-elevated px-2 py-0.5 text-caption text-ink outline-none focus-visible:shadow-focusring"
              />
              <button type="submit" className={`${primaryBtnSm} shrink-0`}>Rename</button>
              <button
                type="button"
                onClick={() => { setRenaming(null); setRenameError(null); }}
                className={`${textBtn} shrink-0`}
              >
                Cancel
              </button>
              {renameError && <span className="shrink-0 text-tiny text-err" role="alert">{renameError}</span>}
            </form>
          ) : (
          <button
            type="button"
            onClick={() => setRenaming(selected.name)}
            title="Rename this dataset"
            aria-label="Rename this dataset"
            className={markBtn}
          >
            <Icon.evals.renameDataset size={ICON.sm} />
          </button>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Import examples from a CSV"
            aria-label="Import examples from a CSV"
            className={markBtn}
          >
            <Icon.evals.importCsv size={ICON.sm} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importCsv(f);
              e.target.value = ""; // let the same file be re-imported
            }}
          />
          <button
            type="button"
            onClick={() => {
              const filename = `${selected.name.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "dataset"}.csv`;
              download(filename, examplesToCsv(examples), "text/csv");
              useUiStore.getState().showToast(`Saved to Downloads as ${filename}`, "ok");
            }}
            disabled={!examples.length}
            title={examples.length ? "Export these cases as a CSV you can import again" : "Nothing to export yet"}
            aria-label="Export these cases as a CSV"
            className={markBtn}
          >
            <Icon.evals.exportCsv size={ICON.sm} />
          </button>
          <button
            type="button"
            onClick={() => sendDuplicateDataset(selected.id)}
            disabled={!connected}
            title="Duplicate this dataset — its cases, check and rubric"
            aria-label="Duplicate this dataset"
            className={markBtn}
          >
            <Icon.evals.duplicateDataset size={ICON.sm} />
          </button>
          <button
            type="button"
            // UNDOABLE FOR FIVE SECONDS rather than gone in one click — see lib/evalUndo.ts.
            onClick={() => deleteWithUndo({
              kind: "dataset", id: selected.id, datasetId: selected.id, agentId: activeAgentId,
              label: selected.name, cases: examples.length,
            })}
            title="Delete this dataset"
            aria-label="Delete this dataset"
            className={`${DANGER_MARK} ml-auto`}
          >
            <Icon.evals.deleteDataset size={ICON.sm} />
          </button>
        </div>
      )}

      {/* HOW THIS DATASET'S ANSWERS ARE SCORED — the check and the judge's rubric — as one surface, in
          the trace's card. Under the dataset actions and above the examples, because it is the
          standard those examples will be scored against. */}
      {selected && (
        <section aria-label="Scoring" className="mx-6 mb-2 shrink-0 rounded-card border border-hair bg-panel">
          <CheckRow dataset={selected} />
          <RubricEditor key={selected.id} datasetId={selected.id} />
        </section>
      )}

      {(error || importNote) && (
        <div className="mx-6 mb-2 flex shrink-0 items-center gap-2 rounded-card border border-hair bg-panel px-3 py-2 text-tiny">
          <span className={`min-w-0 flex-1 ${error ? "text-err" : "text-muted"}`}>{error ?? importNote}</span>
          <button
            type="button"
            onClick={() => { setError(null); setImportNote(null); }}
            title="Dismiss"
            aria-label="Dismiss"
            className={`${iconBtn} shrink-0`}
          >
            <Icon.global.dismissNotice size={ICON.xs} />
          </button>
        </div>
      )}

      {/* examples */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6">
        {!selected ? (
          <EmptyState
            icon={DatabaseIcon}
            title="No dataset yet"
            hint="Create one above, or press the bookmark in the composer while in Test mode to promote the input you just ran."
          />
        ) : examples.length === 0 ? (
          <EmptyState
            icon={DatabaseIcon}
            title="Empty dataset"
            hint="Add an input below, import a CSV, or promote a test input from the composer."
          />
        ) : (
          <>
            {/* §4.2's case list. A dataset's examples arrive with the dataset — `examplesOf` reads
                what the payload carried, and there is no cursor — so the length is a total. */}
            <SectionHeader name="Cases" count={examples.length} className="min-h-8 pb-1" />
            {/* SEARCH, for a list of long cases. The numbers stay each case's own, so "case 7" is case 7. */}
            {examples.length > 5 && (
              <div className="flex items-center gap-2 pb-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a case"
                  aria-label="Find a case"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-input border border-edge bg-elevated px-2 py-1 text-tiny text-ink placeholder:text-faint outline-none focus:shadow-focusring"
                />
                {query.trim() && <span className="shrink-0 text-tiny text-faint">{shownCases.length} of {examples.length}</span>}
              </div>
            )}
            {/* THE CASES AS ONE LIST IN THE TRACE'S CARD, a hairline between each — they were rows of
                text on the page with nothing to say where one case ended and the next began. */}
            {shownCases.length > 0 && (
              <div className="mb-3 divide-y divide-hair rounded-card border border-hair bg-panel">
                {shownCases.map(({ e, i }) => (
                  <ExampleRow key={e.id} example={e} index={i} datasetId={selected.id} agentId={activeAgentId} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* add */}
      {selected && (
        <div className="shrink-0 space-y-2 border-t border-hair px-6 py-3">
          <div className="flex items-end gap-2">
            {/* A BOX, NOT A LINE, and nothing in it is "corrected". A one-line input with the system's
                autocorrect turned `---` into an em dash and straight quotes into curly ones — and for an
                agent that splits a job description from a résumé on `---`, a hand-typed case silently
                became one blob, and an exact-match expectation stopped matching. Enter adds the case;
                Shift+Enter is a new line, as in the case editor above. */}
            <textarea
              value={newInput}
              onChange={(e) => setNewInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addExample(); } }}
              disabled={!connected}
              rows={Math.min(6, Math.max(1, newInput.split("\n").length))}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-label="New case input"
              placeholder="an input the agent should handle — Shift+Enter for a new line"
              className="flex-1 resize-none bg-elevated text-ink placeholder:text-faint rounded-input border border-edge px-2.5 py-1.5 text-caption outline-none focus:shadow-focusring disabled:opacity-50"
            />
            {/* THE BAR'S ONE DECISION, so the one filled button — with its word. It was a mark on the
                same grey as everything around it. */}
            <button
              type="button"
              onClick={addExample}
              disabled={!connected || !newInput.trim()}
              title={!connected ? "Not connected" : !newInput.trim() ? "Type an input first" : "Add this case"}
              className={`${primaryBtnSm} shrink-0`}
            >
              <Icon.evals.addExample size={ICON.sm} />
              Add case
            </button>
          </div>
          {/* THE EXPECTED OUTPUT, AT THE TIME THE CASE IS WRITTEN. It could only be added afterwards, by
              finding the new case in the list and opening its second line. */}
          {newExpected === null ? (
            <button type="button" onClick={() => setNewExpected("")} disabled={!connected} className={`${textBtn} -ml-2`}>
              + expected output
            </button>
          ) : (
            <textarea
              value={newExpected}
              onChange={(e) => setNewExpected(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addExample(); } }}
              disabled={!connected}
              rows={Math.min(4, Math.max(1, newExpected.split("\n").length))}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-label="Expected output for the new case"
              placeholder="what a good answer gives — optional"
              className="w-full resize-none bg-elevated text-ink placeholder:text-faint rounded-input border border-edge px-2.5 py-1.5 text-caption outline-none focus:shadow-focusring disabled:opacity-50"
            />
          )}
        </div>
      )}
    </div>
  );
}

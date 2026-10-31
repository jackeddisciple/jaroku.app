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
import { EmptyState } from "./EmptyState.tsx";
import { SectionHeader } from "./SectionHeader.tsx";
import { DatabaseIcon } from "./panelIcons.tsx";
import { primaryBtnSm, textBtn } from "./buttons.ts";
import { IconButton } from "./IconButton.tsx";
import { Chosen, EVAL_SELECT, FACT_TONE, Pill, SOFT_ICON_SM, SOFT_ICON_XS } from "./evalUi.tsx";
import { cn } from "../lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import type { Dataset, DatasetExample, RubricCriterion } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";

/**
 * A case's own actions — give it an expected output, give it a note, remove it — as small marks at the
 * row's top right. They wait to be reached for: shown on hover and on keyboard focus, so a list of
 * fifty cases is fifty cases rather than fifty rows of controls, and Tab still finds every one.
 */
const CASE_ACTION =
  "self-start inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control bg-active text-faint opacity-0 transition-[opacity,background-color,color] hover:bg-chrome hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-focusring";

/** How the case list is drawn — what a person can turn off to read a long dataset faster. */
interface CaseView {
  expected: boolean;
  notes: boolean;
  fold: boolean;
}

/** An input/expected pair, editable in place. Commits on blur; Escape reverts. */
function ExampleRow({
  example,
  index,
  datasetId,
  agentId,
  view,
}: {
  example: DatasetExample;
  index: number;
  datasetId: string;
  agentId: string;
  view: CaseView;
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
  const folded = view.fold && long && !unfolded;
  const editor = (
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
  );
  /**
   * The expected output or the note, behind its own mark — the target, the note — rather than the
   * caps word that labelled each. Shown when it has text or is being written.
   */
  const extra = (which: "expected" | "notes", text: string) => {
    const Mark = which === "expected" ? Icon.evals.expected : Icon.evals.note;
    return editing === which ? (
      <div className="flex items-start gap-1.5">
        <Mark size={ICON.xs} className="mt-1.5 shrink-0 text-faint" />
        {editor}
      </div>
    ) : (
      <button
        type="button"
        onClick={() => begin(which)}
        title={which === "expected" ? "Expected output — click to edit" : "Note — click to edit"}
        className="-mx-2 flex w-full items-start gap-1.5 rounded-control px-2 py-0.5 text-left text-caption text-muted transition-colors hover:bg-active/50"
      >
        <Mark size={ICON.xs} className="mt-0.5 shrink-0 text-faint" />
        <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
      </button>
    );
  };

  return (
    <div className="group flex gap-3 px-3 py-2.5 transition-colors hover:bg-active/30 focus-within:bg-active/30">
      <span className="text-faint text-tiny tabular-nums pt-1 w-6 shrink-0 text-right select-none">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        {editing === "input" ? editor : (
          // `block`: WEBKIT SIZES A BUTTON FROM ITS CONTENT'S FULL HEIGHT, folded or not — so a folded
          // case kept the unfolded case's height as a blank block under it, in the desktop app and Safari.
          <button
            type="button"
            onClick={() => begin("input")}
            title="Click to edit"
            className="block w-full text-left text-caption rounded-control px-2 py-1 -mx-2 hover:bg-active/50 transition-colors whitespace-pre-wrap break-words text-ink"
          >
            {/* FOLDED WHEN LONG. Unfolded, one case filled the panel and the others were a scroll away. */}
            <span className={folded ? "clamp-lines" : "block"} style={folded ? ({ "--clamp": 4 } as CSSProperties) : undefined}>
              {example.input || "(empty)"}
            </span>
          </button>
        )}
        {long && view.fold && editing !== "input" && (
          <button
            type="button"
            onClick={() => setUnfolded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-xs px-2 text-tiny text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {unfolded ? <Icon.evals.fold size={ICON.xs} /> : <Icon.evals.unfold size={ICON.xs} />}
            {unfolded ? "show less" : "show more"}
          </button>
        )}
        {refusal && <div className="px-2 text-tiny text-err" role="alert">{refusal}</div>}
        {/* NOTES, which the schema and the API carried and the tab never showed. For the person who
            wrote the case — why it is here, what it tests — and never sent to the agent or the judge. */}
        {view.expected && (example.expected || editing === "expected") && extra("expected", example.expected ?? "")}
        {view.notes && (example.notes || editing === "notes") && extra("notes", example.notes ?? "")}
      </div>
      <div className="flex shrink-0 items-start gap-0.5 self-start">
        {!example.expected && editing !== "expected" && (
          <button
            type="button"
            onClick={() => begin("expected")}
            title="Add an expected output — optional; the check and the judge read it"
            aria-label={`Add an expected output to case ${index + 1}`}
            className={CASE_ACTION}
          >
            <Icon.evals.expected size={ICON.xs} />
          </button>
        )}
        {!example.notes && editing !== "notes" && (
          <button
            type="button"
            onClick={() => begin("notes")}
            title="Add a note — why this case is here; never sent to the agent or the judge"
            aria-label={`Add a note to case ${index + 1}`}
            className={CASE_ACTION}
          >
            <Icon.evals.note size={ICON.xs} />
          </button>
        )}
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
          // Red on approach, as every removal is — the one tone swapped, not a second hover colour added.
          className={CASE_ACTION.replace("hover:bg-chrome hover:text-ink", "hover:bg-err/10 hover:text-err")}
        >
          <Icon.evals.removeCase size={ICON.xs} />
        </button>
      </div>
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
      {/* FOLDED AS THE TRACE FOLDS A SECTION: the chevron, the judge's mark, the section's word, and
          what is in it as pills — whose rubric, how many criteria, and whether there is a draft. */}
      <button
        type="button"
        className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-control py-1.5 text-left focus-visible:outline-none focus-visible:shadow-focusring"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden className={`shrink-0 text-faint transition-transform duration-fast ${open ? "" : "-rotate-90"}`}>
          <Icon.trace.fold size={ICON.xs} />
        </span>
        <Icon.evals.judge size={ICON.xs} className="shrink-0 text-faint" />
        <span className={`${TYPE.sectionLabel} shrink-0`}>Judge rubric</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {!loaded ? (
            <span className="text-tiny text-faint">loading…</span>
          ) : (
            <>
              <Pill tone={isDefault ? "neutral" : FACT_TONE.judge} title={isDefault ? "The built-in rubric — this dataset has none of its own" : "This dataset's own rubric"}>
                {isDefault ? "Built-in" : "Custom"}
              </Pill>
              <Pill icon={Icon.evals.criteria} tone={FACT_TONE.judge} title="How many criteria each answer is scored on">{(rubric?.criteria ?? []).length}</Pill>
            </>
          )}
          {dirty && <Pill tone="info" title="Edited and not saved yet">unsaved</Pill>}
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
          {criteria.map((c, i) => {
            const weight = parseWeight(c.weight);
            return (
            <div key={`${c.id}-${i}`} className="rounded-control border border-hair bg-elevated px-2 py-1.5">
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
                <Pill icon={Icon.evals.criterionId} title="The key stored verdicts are recorded against — fixed once it exists">
                  {c.id}
                </Pill>
                {/* THE TEXT AS TYPED, not a number re-rendered from it. `Number("0.")` is 0, so the
                    point vanished as it was typed and "0.25" became "25" — a criterion that then
                    outweighed every other one 125 to 1. */}
                <input
                  value={c.weight}
                  onChange={(e) => edit(i, { weight: e.target.value })}
                  inputMode="decimal"
                  aria-label={`Criterion ${i + 1} weight`}
                  title="Relative weight, 0 to 100"
                  aria-invalid={weight === null}
                  className={`w-14 shrink-0 rounded-input border bg-elevated px-1.5 py-1 text-tiny tabular-nums text-ink outline-none focus-visible:shadow-focusring ${
                    weight === null ? "border-err" : "border-edge"
                  }`}
                />
                {/* ITS SHARE, which is what a weight means once weights are normalised. */}
                <span className="w-9 shrink-0 text-right text-tiny tabular-nums text-faint" title="This criterion's share of the overall score">
                  {weight !== null && total > 0 ? `${Math.round((weight / total) * 100)}%` : "—"}
                </span>
                <IconButton variant="soft"
                  icon={Icon.evals.removeCriterion}
                  label={`Remove criterion ${i + 1}`}
                  size={ICON.xs}
                  danger
                  onClick={() => setDraft(criteria.filter((_, j) => j !== i))}
                />
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
            );
          })}

          {problem && (
            <div className="flex items-center gap-1.5 text-tiny text-err" role="alert">
              <Icon.evals.refused size={ICON.xs} className="shrink-0" />
              {problem}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${textBtn} inline-flex items-center gap-1`}
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
              <Icon.evals.addCriterion size={ICON.xs} />
              Criterion
            </button>
            <span className="text-tiny tabular-nums text-faint" title="The weights' sum — they are normalised, so it need not be 1">
              Σ {total.toFixed(2)}
            </span>
            {/* BACK TO THE BUILT-IN RUBRIC. A saved custom rubric could only ever be edited. Past evals
                keep the criteria they were scored on, so this changes the next eval only. */}
            {!isDefault && !dirty && (
              <button
                type="button"
                onClick={() => sendResetRubric(datasetId)}
                disabled={!connected}
                title="Score this dataset against the built-in rubric again. Past evals keep theirs."
                className={`${textBtn} inline-flex items-center gap-1`}
              >
                <Icon.evals.revertRubric size={ICON.xs} />
                Reset to built-in
              </button>
            )}
            <span className="ml-auto flex items-center gap-1">
              {dirty && (
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  title="Revert to the saved rubric"
                  aria-label="Revert to the saved rubric"
                  className={SOFT_ICON_SM}
                >
                  <Icon.evals.revertRubric size={ICON.xs} />
                </button>
              )}
              {/* SAVING IS THE DECISION THE EDITOR EXISTS TO ASK, so it is the one filled button. */}
              <button
                type="button"
                onClick={save}
                disabled={!connected || !dirty || problem !== null}
                title={!connected ? "Not connected" : problem ?? (dirty ? "Save this rubric for this dataset" : "Nothing to save")}
                // Named as it reads: its words are an expression, which a sweep for marks cannot see.
                aria-label={dirty ? "Save rubric" : "Saved"}
                className={primaryBtnSm}
              >
                <Icon.evals.saveRubric size={ICON.sm} />
                {dirty ? "Save rubric" : "Saved"}
              </button>
            </span>
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
 *
 * ONE MENU, NOT FIVE CHIPS: the check in force is what the row needs to say, and the other four — each
 * with the sentence that says what it does — are a press away, the way an editor's select offers them.
 */
function CheckMenu({ dataset }: { dataset: Dataset }) {
  const connected = useTraceStore((s) => s.connection === "open");
  const current = dataset.check_mode ?? null;
  const chosen = CHECKS.find((c) => c.mode === current) ?? CHECKS[0]!;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-tiny" role="group" aria-label="Check answers against expected">
      <Icon.evals.check size={ICON.xs} className="shrink-0 text-ok" />
      <span className={`${TYPE.sectionLabel} shrink-0`}>Check</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={!connected} className={EVAL_SELECT} title={`${chosen.label} — ${chosen.hint}`} aria-label="How answers are checked against expected">
            <span className={current ? "text-ink" : "text-muted"}>{chosen.label}</span>
            <Icon.evals.menu size={ICON.xs} className="shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent edge="strong" align="start" className="w-[300px]" aria-label="Checks">
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <Icon.evals.check size={ICON.badge} className="text-ok" />
            Check answers against expected
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current ?? "off"} onValueChange={(v) => { const mode = v === "off" ? null : v; if (mode !== current) sendSetDatasetCheck(dataset.id, mode); }}>
            {CHECKS.map((c) => (
              <DropdownMenuRadioItem key={c.label} value={c.mode ?? "off"}>
                <span className="min-w-0 flex-1">
                  <span className="block text-caption text-ink">{c.label}</span>
                  <span className="block text-tiny text-faint">{c.hint}</span>
                </span>
                <Chosen on={c.mode === current} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="min-w-0 truncate text-faint">{chosen.hint}</span>
    </div>
  );
}

/**
 * What the case list shows, as an editor's view menu: three checks, each on until somebody turns it
 * off to read a long dataset faster. The menu stays open while they are flipped.
 */
function ViewMenu({ view, onChange }: { view: CaseView; onChange: (v: CaseView) => void }) {
  const rows: { key: keyof CaseView; label: string }[] = [
    { key: "expected", label: "Show expected outputs" },
    { key: "notes", label: "Show notes" },
    { key: "fold", label: "Fold long cases" },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={SOFT_ICON_SM} aria-label="How the cases are shown" title="How the cases are shown">
          <Icon.evals.viewOptions size={ICON.sm} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent edge="strong" align="end" aria-label="Case view">
        <DropdownMenuLabel>View</DropdownMenuLabel>
        {rows.map((r) => (
          <DropdownMenuCheckboxItem
                      tick="ok"
            key={r.key}
            checked={view[r.key]}
            onCheckedChange={(on) => onChange({ ...view, [r.key]: on === true })}
            onSelect={(e) => e.preventDefault()}
          >
            {r.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  /** What the case list shows — the View menu's three checks, all on until somebody turns one off. */
  const [view, setView] = useState<CaseView>({ expected: true, notes: true, fold: true });
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

  /**
   * The dataset's new name, sent — or the sentence saying why it was not. Shared by the field's
   * Enter and the confirm mark beside it.
   */
  const submitRename = (): void => {
    if (renaming === null || !selected) return;
    const name = renaming.trim();
    if (!name) { setRenameError("A dataset needs a name."); return; }
    if (name.length > 80) { setRenameError("A dataset name can be at most 80 characters."); return; }
    if (name !== selected.name) sendRenameDataset(selected.id, name);
    setRenameError(null);
    setRenaming(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* THE DATASET AND WHAT CAN BE DONE WITH IT, AS ONE TOOLBAR. Which dataset is a menu — each with
          how many cases it holds, and a new one at its foot — and every action on it is a mark whose
          words are its tooltip, with Delete set apart at the row's end. It was a wrapping row of
          chips over a second row of grey squares. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-hair px-4 py-2">
        {renaming !== null && selected ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(e) => { e.preventDefault(); submitRename(); }}
          >
            <Icon.evals.renameDataset size={ICON.sm} className="mr-1 shrink-0 text-faint" />
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
              className={`h-7 min-w-0 flex-1 rounded-input border bg-elevated px-2 text-caption text-ink outline-none focus-visible:shadow-focusring ${renameError ? "border-err" : "border-edge"}`}
            />
            <IconButton variant="soft" icon={Icon.evals.confirm} label="Rename" size={ICON.sm} onClick={submitRename} className="text-ok hover:text-ok" />
            <IconButton variant="soft" icon={Icon.evals.dismiss} label="Keep the old name" size={ICON.sm} onClick={() => { setRenaming(null); setRenameError(null); }} />
            {renameError && <span className="shrink-0 text-tiny text-err" role="alert">{renameError}</span>}
          </form>
        ) : datasets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(EVAL_SELECT, "max-w-[260px]")} aria-label="Choose a dataset" title="The dataset open in this tab — choose another">
                <Icon.evals.datasetView size={ICON.xs} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate">{selected?.name ?? "Choose a dataset"}</span>
                {selected && <span className="shrink-0 tabular-nums text-faint">{examples.length}</span>}
                <Icon.evals.menu size={ICON.xs} className="shrink-0 text-faint" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent edge="strong" align="start" aria-label="Datasets" className="max-h-[360px] w-[280px] overflow-y-auto">
              {/* `listDatasets` answers with all of an agent's, so the length is a total. */}
              <SectionHeader name="Datasets" count={datasets.length} icon={Icon.evals.datasetView} className="px-2.5 py-1" />
              <DropdownMenuRadioGroup value={selectedDatasetId ?? ""} onValueChange={(id) => selectDataset(activeAgentId, id)}>
                {datasets.map((d) => (
                  <DropdownMenuRadioItem key={d.id} value={d.id} title={d.name}>
                    <Icon.evals.datasetView size={ICON.xs} className="shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate text-caption">{d.name}</span>
                    <span className="shrink-0 text-tiny tabular-nums text-faint">{d.example_count ?? 0}</span>
                    <Chosen on={d.id === selectedDatasetId} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem size="compact" disabled={!connected} onSelect={() => sendCreateDataset(activeAgentId)}>
                <Icon.evals.newDataset size={ICON.xs} />
                New dataset
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="flex items-center gap-1.5 text-caption text-muted">
            <Icon.evals.datasetView size={ICON.xs} className="text-faint" />
            No datasets yet
          </span>
        )}
        {renaming === null && (
          // NO NAME: the server picks one this agent does not have. Numbering from the count here gave
          // two "Test set 3"s after a delete. Agent names are not used — they are generated from prompts
          // and run long, and the agent is already established by the sidebar.
          <IconButton variant="soft"
            icon={Icon.evals.newDataset}
            label="New dataset"
            size={ICON.sm}
            disabledReason={connected ? null : "Not connected"}
            onClick={() => sendCreateDataset(activeAgentId)}
          />
        )}
        {selected && renaming === null && (
          <>
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hair" />
            <IconButton variant="soft" icon={Icon.evals.renameDataset} label="Rename this dataset" size={ICON.sm} onClick={() => setRenaming(selected.name)} />
            <IconButton variant="soft" icon={Icon.evals.importCsv} label="Import examples from a CSV" size={ICON.sm} onClick={() => fileRef.current?.click()} />
            <IconButton variant="soft"
              icon={Icon.evals.exportCsv}
              label="Export these cases as a CSV"
              size={ICON.sm}
              disabledReason={examples.length ? null : "Nothing to export yet"}
              onClick={() => {
                const filename = `${selected.name.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "dataset"}.csv`;
                download(filename, examplesToCsv(examples), "text/csv");
                useUiStore.getState().showToast(`Saved to Downloads as ${filename}`, "ok");
              }}
            />
            <IconButton variant="soft"
              icon={Icon.evals.duplicateDataset}
              label="Duplicate this dataset"
              size={ICON.sm}
              disabledReason={connected ? null : "Not connected"}
              onClick={() => sendDuplicateDataset(selected.id)}
            />
            <span className="ml-auto" />
            {/* UNDOABLE FOR FIVE SECONDS rather than gone in one click — see lib/evalUndo.ts. */}
            <IconButton variant="soft"
              icon={Icon.evals.deleteDataset}
              label="Delete this dataset"
              size={ICON.sm}
              danger
              onClick={() => deleteWithUndo({
                kind: "dataset", id: selected.id, datasetId: selected.id, agentId: activeAgentId,
                label: selected.name, cases: examples.length,
              })}
            />
          </>
        )}
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
      </div>

      {/* HOW THIS DATASET'S ANSWERS ARE SCORED — the check and the judge's rubric — as one surface, in
          the trace's card. Under the dataset actions and above the examples, because it is the
          standard those examples will be scored against. */}
      {selected && (
        <section aria-label="Scoring" className="mx-4 mb-2 mt-3 shrink-0 rounded-card border border-hair bg-panel">
          <CheckMenu dataset={selected} />
          <RubricEditor key={selected.id} datasetId={selected.id} />
        </section>
      )}

      {(error || importNote) && (
        <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-card border border-hair bg-panel px-3 py-2 text-tiny" role={error ? "alert" : "status"}>
          {error
            ? <Icon.evals.refused size={ICON.sm} className="shrink-0 text-err" />
            : <Icon.evals.importCsv size={ICON.sm} className="shrink-0 text-faint" />}
          <span className={`min-w-0 flex-1 ${error ? "text-err" : "text-muted"}`}>{error ?? importNote}</span>
          <button
            type="button"
            onClick={() => { setError(null); setImportNote(null); }}
            title="Dismiss"
            aria-label="Dismiss"
            className={SOFT_ICON_XS}
          >
            <Icon.global.dismissNotice size={ICON.xs} />
          </button>
        </div>
      )}

      {/* examples */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4">
        {!selected ? (
          <EmptyState
            icon={DatabaseIcon}
            title="No dataset yet"
            hint="Create one with the mark above, or press the bookmark in the composer while in Test mode to promote the input you just ran."
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
                what the payload carried, and there is no cursor — so the length is a total. The
                search and the view menu sit on its header, as an editor's list puts them. */}
            <div className="sticky top-0 z-10 flex min-h-10 items-center gap-2 bg-bg py-1.5">
              <SectionHeader name="Cases" count={examples.length} icon={Icon.evals.cases} className="shrink-0" />
              {/* SEARCH, for a list of long cases. The numbers stay each case's own, so "case 7" is case 7. */}
              {examples.length > 5 ? (
                <div className="relative min-w-0 flex-1">
                  <Icon.evals.search size={ICON.xs} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
                    placeholder="Find a case"
                    aria-label="Find a case"
                    spellCheck={false}
                    className="h-7 w-full rounded-input border border-edge bg-elevated pl-7 pr-7 text-tiny text-ink placeholder:text-faint outline-none focus:shadow-focusring"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear the search"
                      title="Clear the search"
                      className={cn(SOFT_ICON_XS, "absolute right-1 top-1/2 h-5 w-5 -translate-y-1/2 rounded-xs")}
                    >
                      <Icon.evals.clearSearch size={ICON.xs} />
                    </button>
                  )}
                </div>
              ) : <span className="flex-1" />}
              {needle && <span className="shrink-0 text-tiny tabular-nums text-faint">{shownCases.length} of {examples.length}</span>}
              <ViewMenu view={view} onChange={setView} />
            </div>
            {/* THE CASES AS ONE LIST IN THE TRACE'S CARD, a hairline between each — they were rows of
                text on the page with nothing to say where one case ended and the next began. */}
            {shownCases.length > 0 ? (
              <div className="mb-3 divide-y divide-hair overflow-hidden rounded-card border border-hair bg-panel">
                {shownCases.map(({ e, i }) => (
                  <ExampleRow key={e.id} example={e} index={i} datasetId={selected.id} agentId={activeAgentId} view={view} />
                ))}
              </div>
            ) : (
              <div className="mb-3 flex items-center gap-2 rounded-card border border-hair bg-panel px-3 py-3 text-tiny text-faint">
                <Icon.evals.search size={ICON.xs} className="shrink-0" />
                No case has “{query.trim()}” in it.
              </div>
            )}
          </>
        )}
      </div>

      {/* add — A COMPOSER, as the chat's is: the box, and under it what else the case can carry and the
          one button that adds it. */}
      {selected && (
        <div className="shrink-0 border-t border-hair px-4 py-3">
          <div className="rounded-input border border-edge bg-elevated transition-shadow focus-within:shadow-focusring">
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
              rows={Math.min(6, Math.max(2, newInput.split("\n").length))}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-label="New case input"
              placeholder="An input the agent should handle"
              className="block w-full resize-none bg-transparent px-2.5 pb-1 pt-2 text-caption text-ink placeholder:text-faint outline-none disabled:opacity-50"
            />
            {/* THE EXPECTED OUTPUT, AT THE TIME THE CASE IS WRITTEN. It could only be added afterwards, by
                finding the new case in the list and opening its second line. */}
            {newExpected !== null && (
              <div className="flex items-start gap-1.5 border-t border-hair px-2.5 py-1.5">
                <Icon.evals.expected size={ICON.xs} className="mt-1 shrink-0 text-faint" />
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
                  placeholder="What a good answer gives — optional"
                  className="block min-w-0 flex-1 resize-none bg-transparent py-0.5 text-caption text-ink placeholder:text-faint outline-none disabled:opacity-50"
                />
              </div>
            )}
            <div className="flex items-center gap-1 px-1.5 pb-1.5">
              <button
                type="button"
                onClick={() => setNewExpected(newExpected === null ? "" : null)}
                disabled={!connected}
                aria-pressed={newExpected !== null}
                aria-label="Give the new case an expected output"
                title={newExpected === null ? "Give the new case an expected output — optional" : "Leave the expected output off"}
                className={`${textBtn} inline-flex items-center gap-1 ${newExpected !== null ? "bg-active text-ink" : ""}`}
              >
                <Icon.evals.expected size={ICON.xs} />
                Expected
              </button>
              <button type="button" onClick={() => fileRef.current?.click()} className={`${textBtn} inline-flex items-center gap-1`} title="Import examples from a CSV">
                <Icon.evals.importCsv size={ICON.xs} />
                CSV
              </button>
              <span className="ml-auto pr-1 text-tiny text-faint" title="Enter adds the case; Shift+Enter is a new line">⏎</span>
              {/* THE BAR'S ONE DECISION, so the one filled button — with its word. */}
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
          </div>
        </div>
      )}
    </div>
  );
}

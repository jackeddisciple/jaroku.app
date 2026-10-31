// The five seconds in which a deleted dataset or case can be put back. See lib/evalUndo.ts.
//
// It renders into the corner every toast shares, as the Inbox's undo does, so it moves nothing and
// stacks with anything else said there.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_STACK_ID } from "./Toast.tsx";
import { useEvalStore } from "../store/evalStore.ts";
import { undoPendingDelete } from "../lib/evalUndo.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { Button } from "./ui/button.tsx";

export function EvalUndoToast() {
  const pending = useEvalStore((s) => s.pendingDelete);
  const [stack, setStack] = useState<HTMLElement | null>(null);
  useEffect(() => setStack(document.getElementById(TOAST_STACK_ID)), []);
  if (!pending || !stack) return null;

  const what =
    pending.kind === "dataset"
      ? `Deleted “${pending.label}”${pending.cases ? ` · ${pending.cases} case${pending.cases === 1 ? "" : "s"}` : ""}`
      : `Deleted case “${pending.label}”`;
  return createPortal(
    <div
      key={`${pending.kind}-${pending.id}-${pending.at}`}
      className="pointer-events-auto flex max-w-xs animate-slide-in items-center gap-2 rounded-card border border-grip bg-elevated py-1 pl-2.5 pr-1 text-tiny text-muted shadow-overlay motion-reduce:animate-none"
      role="status"
      aria-live="polite"
    >
      {/* WHAT WENT, BY ITS MARK — the dataset's or the case's own delete — before the words. */}
      {pending.kind === "dataset"
        ? <Icon.evals.deleteDataset size={ICON.xs} className="shrink-0 text-faint" />
        : <Icon.evals.removeCase size={ICON.xs} className="shrink-0 text-faint" />}
      <span className="min-w-0 truncate text-ink">{what}</span>
      {/* THE WAY BACK, on its own soft square — shadcn's button, as the panel's other actions are. */}
      <Button variant="soft" size="xs" onClick={undoPendingDelete} className="ml-auto text-ink">
        <Icon.evals.undo size={ICON.xs} />
        Undo
      </Button>
    </div>,
    stack,
  );
}

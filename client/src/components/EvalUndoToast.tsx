// The five seconds in which a deleted dataset or case can be put back. See lib/evalUndo.ts.
//
// It renders into the corner every toast shares, as the Inbox's undo does, so it moves nothing and
// stacks with anything else said there.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_STACK_ID } from "./Toast.tsx";
import { useEvalStore } from "../store/evalStore.ts";
import { undoPendingDelete } from "../lib/evalUndo.ts";

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
      className="pointer-events-auto flex max-w-xs animate-slide-in items-center gap-2 rounded-card border border-edge bg-elevated py-1 pl-3 pr-1.5 text-tiny text-muted shadow-overlay motion-reduce:animate-none"
      role="status"
      aria-live="polite"
    >
      <span className="min-w-0 truncate text-ink">{what}</span>
      <button
        onClick={undoPendingDelete}
        className="ml-auto shrink-0 rounded-control px-2 py-0.5 text-tiny text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
      >
        Undo
      </button>
    </div>,
    stack,
  );
}

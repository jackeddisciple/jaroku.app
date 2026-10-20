// Deleting a dataset or a case, with five seconds to take it back.
//
// THE DELETE WAS ONE CLICK. A trash icon removed a fifteen-case dataset at once, and a case's delete
// was a strip down its whole right edge that one stray click fired — with no confirmation and no way
// back, in a webview that has no `confirm()` to offer one anyway. The product's rule for destructive
// actions is the Inbox's: no confirmation dialog, a five-second toast with Undo. So the item leaves
// the list at once and the command waits out the window; Undo puts it back, and nothing was sent.
//
// A SECOND DELETE INSIDE THE WINDOW SENDS THE FIRST. One slot, as every toast here has one — the newer
// action is the one still on offer, and the older one is a decision the person has already moved past.

import { sendDeleteDataset, sendDeleteExample } from "./socket.ts";
import { useEvalStore, type PendingDelete } from "../store/evalStore.ts";

/** The window, the Inbox's five seconds. */
export const UNDO_MS = 5_000;

let timer: ReturnType<typeof setTimeout> | null = null;

/** Take the item out of the list now; send the delete when the window closes, unless undone. */
export function deleteWithUndo(d: Omit<PendingDelete, "at">): void {
  flushPendingDelete();
  const store = useEvalStore.getState();
  store.setPendingDelete({ ...d, at: Date.now() });
  // A dataset going away takes the selection to the next one, and Undo brings it back.
  if (d.kind === "dataset" && store.selectedDatasetByAgent[d.agentId] === d.id) {
    const next = (store.datasetsByAgent[d.agentId] ?? []).find((x) => x.id !== d.id)?.id ?? null;
    store.selectDataset(d.agentId, next);
  }
  timer = setTimeout(flushPendingDelete, UNDO_MS);
}

/** Put it back. Nothing was sent, so there is nothing to reverse. */
export function undoPendingDelete(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const store = useEvalStore.getState();
  const p = store.pendingDelete;
  store.setPendingDelete(null);
  if (p?.kind === "dataset") store.selectDataset(p.agentId, p.id);
}

/** Send the delete that is waiting, now. */
export function flushPendingDelete(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const p = useEvalStore.getState().pendingDelete;
  if (!p) return;
  useEvalStore.getState().setPendingDelete(null);
  if (p.kind === "dataset") sendDeleteDataset(p.datasetId, p.agentId);
  else sendDeleteExample(p.datasetId, p.id);
}

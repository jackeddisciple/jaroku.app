// Saving a test input as an eval case — into a dataset somebody chose, with what it should answer.
//
// IT SAVED INTO WHICHEVER DATASET WAS TOUCHED LAST. Not the one open in the Evals tab, with no way to
// pick another, and no way to say what the answer should be — the confirmation then named a dataset
// the person had not been looking at. The bar's button now opens a small form: where it goes (the
// Evals tab's dataset first), what it should answer, and Save.

import { useEffect, useRef, useState } from "react";
import { ControlButton } from "./ControlButton.tsx";
import { Popover } from "./Popover.tsx";
import { Chip } from "../Chip.tsx";
import { Icon } from "../../lib/icons/registry.ts";
import { sendListDatasets, sendPromoteTestInput } from "../../lib/socket.ts";
import { datasetsOf, useEvalStore } from "../../store/evalStore.ts";

export function SaveCaseControl({
  agentId,
  agentName,
  input,
  connected,
  label,
}: {
  agentId: string;
  agentName?: string;
  /** The test input to save — the draft, or the last one sent. Empty means nothing to save. */
  input: string;
  connected: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [expected, setExpected] = useState("");
  const [into, setInto] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const datasets = useEvalStore((s) => datasetsOf(s.datasetsByAgent, agentId));
  const evalsDataset = useEvalStore((s) => s.selectedDatasetByAgent[agentId] ?? null);
  const promoted = useEvalStore((s) => s.promoted);
  // The Evals tab's dataset unless another was picked here; "new" for one that does not exist yet.
  const target = into ?? (datasets.some((d) => d.id === evalsDataset) ? evalsDataset : datasets[0]?.id ?? "new");

  useEffect(() => {
    if (open && connected) sendListDatasets(agentId);
  }, [open, connected, agentId]);

  const save = (): void => {
    if (!input) return;
    sendPromoteTestInput(agentId, input, agentName, expected.trim() || null, target ?? "new");
    setExpected("");
    setInto(null);
    setOpen(false);
  };

  return (
    <div className="relative shrink-0">
      <ControlButton
        buttonRef={triggerRef}
        icon={Icon.attach.dataset}
        name="Save this test input as an eval case"
        label={label}
        title={
          promoted
            ? promoted.duplicate ? `already in ${promoted.datasetName}` : `saved to ${promoted.datasetName}`
            : input ? "Save this test input as a case — choose the dataset and what it should answer" : "Type or run a test input first"
        }
        expanded={open}
        active={open || Boolean(promoted)}
        disabled={!connected || !input}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Save as an eval case" width={320}>
        <div className="space-y-2 p-2 text-tiny">
          <div className="text-faint">Save as a case in</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Dataset to save into">
            {datasets.map((d) => (
              <Chip key={d.id} size="sm" selected={target === d.id} onClick={() => setInto(d.id)} title={d.name} className="max-w-[160px]">
                <span className="truncate">{d.name}</span>
              </Chip>
            ))}
            <Chip size="sm" selected={target === "new"} onClick={() => setInto("new")} title="A new dataset for this agent">
              New dataset
            </Chip>
          </div>
          <textarea
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            rows={2}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="What it should answer (optional)"
            aria-label="Expected output (optional)"
            className="w-full resize-none rounded-input border border-edge bg-elevated px-2 py-1 text-tiny text-ink placeholder:text-faint outline-none focus:shadow-focusring"
          />
          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={!connected || !input}
              className="rounded-control bg-active px-2.5 py-1 text-tiny text-ink transition-opacity disabled:opacity-30"
            >
              Save case
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

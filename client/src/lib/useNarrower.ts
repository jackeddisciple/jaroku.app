// Whether an element is narrower than a width — for the eval views that turn a table into cards.
//
// THE SAME TWELVE LINES WERE WRITTEN TWICE, in the comparison table and in the comparison with an
// earlier eval, each measuring its own box against the same 560px. A third view needing the
// answer is the point at which a copy becomes a thing that drifts, so it is one hook now.
//
// FALSE UNTIL MEASURED, and false where there is no ResizeObserver (a server render, a test): the
// wide layout is what static markup has always rendered, so nothing that reads it changes.

import { useEffect, useRef, useState, type RefObject } from "react";

export function useNarrowerThan<T extends HTMLElement>(px: number): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? Infinity) < px));
    ro.observe(el);
    return () => ro.disconnect();
  }, [px]);
  return [ref, narrow];
}

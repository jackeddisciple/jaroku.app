import { useMemo, useState } from "react";

export const TOOL_PAGE = 50;
export const TOOL_FILTER_AT = 20;

export interface ToolWindowState {
  query: string;
  shown: number;
}

export const FIRST_TOOL_PAGE: ToolWindowState = { query: "", shown: TOOL_PAGE };

export function searchTools(query: string): ToolWindowState {
  return { query, shown: TOOL_PAGE };
}

export function showMoreTools(state: ToolWindowState): ToolWindowState {
  return { ...state, shown: state.shown + TOOL_PAGE };
}

export function matchTools<T>(items: readonly T[], query: string, text: (item: T) => string): readonly T[] {
  const needle = query.trim().toLowerCase();
  return needle ? items.filter((item) => text(item).toLowerCase().includes(needle)) : items;
}

export interface ToolWindow<T> {
  visible: readonly T[];
  matched: number;
  remaining: number;
  filterable: boolean;
}

export function toolWindow<T>(items: readonly T[], matched: readonly T[], state: ToolWindowState): ToolWindow<T> {
  const visible = matched.length > state.shown ? matched.slice(0, state.shown) : matched;
  return {
    visible,
    matched: matched.length,
    remaining: matched.length - visible.length,
    filterable: items.length > TOOL_FILTER_AT,
  };
}

export function moreToolsLabel(remaining: number): string {
  return remaining > TOOL_PAGE ? `Show ${TOOL_PAGE} more (${remaining} not shown)` : `Show the other ${remaining}`;
}

export function useToolWindow<T>(
  items: readonly T[],
  text: (item: T) => string,
): ToolWindow<T> & { query: string; search: (query: string) => void; more: () => void } {
  const [state, setState] = useState<ToolWindowState>(FIRST_TOOL_PAGE);
  const matched = useMemo(() => matchTools(items, state.query, text), [items, state.query, text]);
  return {
    ...toolWindow(items, matched, state),
    query: state.query,
    search: (query) => setState(searchTools(query)),
    more: () => setState(showMoreTools),
  };
}

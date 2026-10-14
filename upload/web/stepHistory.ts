// Steps 1 to 3 as real browser history entries (#30, #59), so the phone's or
// browser's Back goes to the previous step instead of leaving the page.
//
// Each entry the page makes carries its step's place (0, 1 or 2) and which
// visit to the page made it. Once sending starts the page goes back to its
// first entry, so Back from there leaves the page, and the leave-the-page
// warning (interruptions.ts) asks the member first. Forward is not followed:
// a later step needs what the member did to reach it.
import { useEffect, useRef } from "react";

const KEY = "sdfwaStep";

interface Entry {
  index: number;
  visit: string;
}

function entryOf(state: unknown): Entry | undefined {
  const entry = (state as Record<string, unknown> | null)?.[KEY] as Partial<Entry> | undefined;
  return typeof entry?.index === "number" && typeof entry.visit === "string" ? { index: entry.index, visit: entry.visit } : undefined;
}

/**
 * `onBack(index)` is called when the member goes back to an earlier step's
 * entry. Returns `moveTo(index)`, which brings the history in line with a
 * step the page moved to by itself.
 */
export function useStepHistory(onBack: (index: number) => void): (index: number) => void {
  const visit = useRef(Math.random().toString(36).slice(2));
  const current = useRef(0);
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => {
    const here = (index: number) => ({ ...(history.state as object | null), [KEY]: { index, visit: visit.current } });
    history.replaceState(here(current.current), "");
    const pop = (event: PopStateEvent) => {
      const entry = entryOf(event.state);
      // Not one of this visit's (from before a reload): nothing to show for it.
      if (!entry || entry.visit !== visit.current || entry.index === current.current) return;
      if (entry.index > current.current) {
        // Forward: go back to where the member is.
        history.go(current.current - entry.index);
        return;
      }
      current.current = entry.index;
      latest.current(entry.index);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  return (index: number) => {
    const from = current.current;
    if (index === from) return;
    current.current = index;
    if (index < from) {
      // The popstate that follows finds the page already there.
      history.go(index - from);
      return;
    }
    for (let i = from + 1; i <= index; i++) history.pushState({ [KEY]: { index: i, visit: visit.current } }, "");
  };
}

// The live choices for the three list fields (ADR 0003): Program / Event,
// Subject Type and Location, as ResourceSpace offers them now. Option names
// are shown and written exactly as ResourceSpace defines them, so wording is
// edited there and the form follows.
//
// Cached briefly, so a page load or a Submission does not cost three calls
// each. A choice not in the cached list is looked up again before it is
// refused, so a choice an administrator has just added is never turned away.
import { CHOICE_FIELDS, type Options } from "../shared/details.ts";
import type { ResourceSpace } from "./resourcespace.ts";

/** How long a fetched list is used before asking ResourceSpace again. */
export const OPTIONS_CACHE_MS = 2 * 60 * 1000;

export interface LiveOptions {
  /**
   * The choices for every list field, fetched afresh when the cached ones are
   * older than `maxAgeMs` (the cache's own lifetime by default; 0 for now).
   * Rejects when ResourceSpace cannot be asked.
   */
  get(maxAgeMs?: number): Promise<Options>;
}

export function createLiveOptions(rs: ResourceSpace, now: () => number = Date.now): LiveOptions {
  let cached: { at: number; options: Options } | undefined;
  // One fetch at a time: everyone asking meanwhile shares its answer.
  let fetching: Promise<Options> | undefined;

  function fetchAll(): Promise<Options> {
    fetching ??= (async () => {
      const at = now();
      try {
        const lists = await Promise.all(CHOICE_FIELDS.map((f) => rs.fieldOptions(f)));
        const options = Object.fromEntries(CHOICE_FIELDS.map((f, i) => [f, lists[i]!])) as Options;
        cached = { at, options };
        return options;
      } finally {
        fetching = undefined;
      }
    })();
    return fetching;
  }

  return {
    async get(maxAgeMs = OPTIONS_CACHE_MS) {
      if (cached && now() - cached.at <= maxAgeMs && maxAgeMs > 0) return cached.options;
      return fetchAll();
    },
  };
}

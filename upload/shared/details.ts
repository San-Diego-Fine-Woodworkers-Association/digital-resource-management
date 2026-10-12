// The details a member gives once for a whole Submission in Step 2 (#19,
// ADR 0003). Shared so the page and the service apply the same rules.
//
// The field list is static configuration: which ResourceSpace fields are
// asked, by shortname (refs differ between hosts), in what order, and which
// are required. Only the choices inside the three list fields come live from
// ResourceSpace. There is no drift check: if an administrator makes another
// field required, the form will not know (ADR 0003).
//
// The page's labels for these are in web/copy.ts.

/** Every field Step 2 asks, by ResourceSpace shortname, in the order the form shows them. */
export const DETAIL_FIELDS = ["title", "programevent", "subjecttype", "date", "location", "eventname", "caption"] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

/** Required: Title, Program / Event and Subject Type (at least one). ResourceSpace's API does not enforce these. */
export const REQUIRED_FIELDS: readonly DetailField[] = ["title", "programevent", "subjecttype"];

/** The fields whose choices come live from ResourceSpace. Subject Type takes many; the others one. */
export const CHOICE_FIELDS = ["programevent", "subjecttype", "location"] as const;
export type ChoiceField = (typeof CHOICE_FIELDS)[number];

/** The choices ResourceSpace currently offers for each list field, in its order. */
export type Options = Record<ChoiceField, string[]>;

export interface Details {
  title: string;
  programevent: string;
  subjecttype: string[];
  /** `YYYY-MM-DD`, or empty: then nothing is written, so ResourceSpace keeps the photo's own date. */
  date: string;
  location: string;
  eventname: string;
  caption: string;
}

export const NO_DETAILS: Details = {
  title: "",
  programevent: "",
  subjecttype: [],
  date: "",
  location: "",
  eventname: "",
  caption: "",
};

/** The longest each text field may be. ResourceSpace holds far more; these only stop abuse. */
export const MAX_LENGTH = { title: 200, eventname: 200, caption: 2000 } as const;

export type Problem = "required" | "not_offered" | "invalid" | "too_long";
export interface FieldProblem {
  field: DetailField;
  problem: Problem;
}

/** The required fields not yet filled in, in the form's order. */
export function stillNeeded(d: Details): DetailField[] {
  return REQUIRED_FIELDS.filter((f) => (f === "subjecttype" ? d.subjecttype.length === 0 : d[f].trim() === ""));
}

/**
 * One Item's own answers from Step 3 (#57): only the fields it changes. A
 * blank one (an emptied box, no subject ticked) means "use the Step 2
 * answer", so an Item can never blank a field Step 2 filled in. The rights
 * confirmation is not here: it is given once for the whole Submission.
 */
export type Changes = Partial<Details>;

const isBlank = (v: unknown) => (Array.isArray(v) ? v.length === 0 : typeof v !== "string" || v.trim() === "");

/**
 * The Step 2 answers with an Item's changes laid over them: each field the
 * Item filled in replaces the Step 2 answer, and every blank one keeps it.
 * Not checked; anything not a known field is dropped.
 */
export function withChanges(base: Details, changes: unknown): Details {
  const c = (typeof changes === "object" && changes !== null && !Array.isArray(changes) ? changes : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const field of DETAIL_FIELDS) if (field in c && !isBlank(c[field])) out[field] = c[field];
  return out as unknown as Details;
}

/** The fields an Item's changes actually change from the Step 2 answers, in the form's order. */
export function changedFields(base: Details, changes: unknown): DetailField[] {
  const item = withChanges(base, changes);
  // Compared as they will be saved: ends trimmed, subjects in any order.
  const same = (v: string | string[]) => (Array.isArray(v) ? JSON.stringify([...v].sort()) : v.trim());
  return DETAIL_FIELDS.filter((f) => same(item[f]) !== same(base[f]));
}

/** One line of text: control characters become spaces, and the ends are trimmed. */
function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
}

/** Several lines: line breaks are kept as `\n`, other control characters dropped. */
function lines(v: unknown): string {
  return typeof v === "string"
    ? v
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
        .trim()
    : "";
}

/** A real calendar date written `YYYY-MM-DD`, as a date input gives it. */
export function isDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Checks what a member sent against the field rules and the live choices.
 * Anything not a known field is dropped. Answers come back cleaned (trimmed,
 * no control characters, no repeated choices) or with every problem found.
 */
export function checkDetails(raw: unknown, options: Options): { details: Details } | { problems: FieldProblem[] } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const subjects = Array.isArray(r.subjecttype) ? r.subjecttype : [];
  const details: Details = {
    title: oneLine(r.title),
    programevent: oneLine(r.programevent),
    subjecttype: [...new Set(subjects.map(oneLine).filter(Boolean))],
    date: oneLine(r.date),
    location: oneLine(r.location),
    eventname: oneLine(r.eventname),
    caption: lines(r.caption),
  };

  const problems: FieldProblem[] = stillNeeded(details).map((field) => ({ field, problem: "required" as const }));
  if (subjects.some((s) => typeof s !== "string")) problems.push({ field: "subjecttype", problem: "invalid" });
  for (const field of ["title", "eventname", "caption"] as const) {
    if (details[field].length > MAX_LENGTH[field]) problems.push({ field, problem: "too_long" });
  }
  if (details.date && !isDate(details.date)) problems.push({ field: "date", problem: "invalid" });
  for (const field of ["programevent", "location"] as const) {
    if (details[field] && !options[field].includes(details[field])) problems.push({ field, problem: "not_offered" });
  }
  if (details.subjecttype.some((s) => !options.subjecttype.includes(s))) {
    problems.push({ field: "subjecttype", problem: "not_offered" });
  }

  if (problems.length > 0) {
    // In the form's order, one problem per field.
    const seen = new Set<DetailField>();
    return {
      problems: DETAIL_FIELDS.flatMap((f) => problems.filter((p) => p.field === f)).filter(
        (p) => !seen.has(p.field) && seen.add(p.field),
      ),
    };
  }
  return { details };
}

/** The page's own name for an Item, which its hand-off repeats (#57). Never shown or stored in ResourceSpace. */
const ITEM_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export interface ItemProblem extends FieldProblem {
  /** Which Item, by the page's name for it. */
  item: string;
}

/**
 * Checks every Item's own answers (#57) exactly as the Step 2 answers are
 * checked: each Item's full set (Step 2 with its changes laid over) must
 * pass `checkDetails`. Only the fields an Item changed are reported for it;
 * the rest are Step 2's and reported once, there. Items that change nothing
 * are left out. `invalid` when the shape is wrong: not an object, a name
 * that is not one, or more Items than the Submission can hold.
 */
export function checkItems(
  raw: unknown,
  base: Details,
  options: Options,
  maxItems: number,
): { items: Record<string, Details> } | { problems: ItemProblem[] } | { invalid: true } {
  if (raw === undefined) return { items: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { invalid: true };
  const entries = Object.entries(raw);
  if (entries.length > maxItems || entries.some(([key]) => !ITEM_KEY.test(key))) return { invalid: true };

  // No prototype, so an Item named like one of Object's own properties is just a name.
  const items: Record<string, Details> = Object.create(null);
  const problems: ItemProblem[] = [];
  for (const [item, changes] of entries) {
    const changed = changedFields(base, changes);
    if (changed.length === 0) continue;
    const checked = checkDetails(withChanges(base, changes), options);
    if ("problems" in checked) {
      problems.push(...checked.problems.filter((p) => changed.includes(p.field)).map((p) => ({ item, ...p })));
    } else items[item] = checked.details;
  }
  return problems.length > 0 ? { problems } : { items };
}

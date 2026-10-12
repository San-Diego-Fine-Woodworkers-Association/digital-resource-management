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

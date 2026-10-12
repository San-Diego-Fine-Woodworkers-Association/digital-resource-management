// The names and stamps the service makes for an Item (#19): the Submission
// ID, the synthesized File name, and the rights-confirmation record.
import { randomInt } from "node:crypto";
import { RIGHTS_STATEMENT } from "../shared/rights.ts";

// Lower-case letters and digits without look-alikes (no 0/o, 1/l/i). Plain
// alphanumerics so ResourceSpace indexes a Submission ID as one search word.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A new Submission ID: 12 characters. Its first 6 are the short code in file names. */
export function newSubmissionId(): string {
  let id = "";
  for (let i = 0; i < 12; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

export function isSubmissionId(id: string): boolean {
  return new RegExp(`^[${ALPHABET}]{12}$`).test(id);
}

export function submissionCode(submissionId: string): string {
  return submissionId.slice(0, 6);
}

const MAX_SLUG = 60;

/** The Title as a lowercase ASCII hyphenated slug, bounded in length; "photo" if nothing is left. */
export function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents off: café -> cafe
    .toLowerCase()
    .replace(/['’]/g, "") // pat's -> pats
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return s || "photo";
}

/**
 * The File name an Item is stored and downloaded under, e.g.
 * `2026-05-03_dovetail-class_7k3q9x-001.jpg`: the member's Date (left out when
 * not given; never guessed), the slugged Title, the Submission code and the
 * zero-padded Item number, and the extension of the detected type.
 */
export function fileName(opts: { date?: string; title: string; submissionId: string; itemNumber: number; extension: string }) {
  const parts = [
    ...(opts.date ? [opts.date] : []),
    slug(opts.title),
    `${submissionCode(opts.submissionId)}-${String(opts.itemNumber).padStart(3, "0")}`,
  ];
  return `${parts.join("_")}.${opts.extension}`;
}

/** e.g. `Confirmed 2026-10-05 14:32 PT: "I took these, ..."` (#19), in Pacific time. */
export function rightsRecord(at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `Confirmed ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PT: "${RIGHTS_STATEMENT}"`;
}

/** The name the member's device gave the file, made safe to store as text: no path, no control characters, bounded. */
export function originalFileName(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, 255) || "(no name)";
}

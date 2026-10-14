// The Reviewers' email itself (#61): what it says, made safe, and how it is
// handed to the Google Workspace SMTP relay (ADR 0006).
//
// What a member typed (the Step 2 answers, and their name from the auth
// service) is escaped everywhere it goes into the HTML, and has its line
// breaks taken out wherever it goes into a header (the subject, Reply-To).
// The wording is in email-copy.ts.
import { isIP } from "node:net";
import type tls from "node:tls";
import nodemailer from "nodemailer";
import type { Details } from "../shared/details.ts";
import type { ReviewerEmail } from "./config.ts";
import { emailCopy as copy } from "./email-copy.ts";

export type EmailKind = "complete" | "partial" | "unknown";

export interface EmailFacts {
  kind: EmailKind;
  submissionId: string;
  /** Who started it, from the verified session; unknown only if its state was lost. */
  submitter?: { name: string; email: string };
  /** What arrived in ResourceSpace. */
  sent: { photos: number; videos: number };
  /** From the Submission's record; absent for "unknown". */
  expectedItems?: number;
  details?: Details;
  /** How many Items were changed one by one in Step 3. */
  ownDetails?: number;
  /** Why a partial went: the page said it finished, or nothing arrived for this many minutes. */
  why?: { finished: true } | { stalledMinutes: number };
}

export interface Email {
  subject: string;
  text: string;
  html: string;
  /** The member's address, so a Reviewer can just press Reply. */
  replyTo?: { name: string; address: string };
}

/** The Submission's Items in Pending Review (confirmed on production in #36). */
export function reviewLink(publicBaseUrl: string, submissionId: string): string {
  return `${publicBaseUrl}/pages/search.php?search=submissionid%3A${encodeURIComponent(submissionId)}&archive=-1`;
}

/** For the HTML part: every character that could start markup or end an attribute. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** For a header: no line breaks (CR, LF, or any other line or paragraph separator), so nothing can start a new header. */
export function oneLine(s: string): string {
  return s.replace(/[\r\n\u0085\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** A plain address: anything else is left out of Reply-To rather than trusted. */
const PLAIN_ADDRESS = /^[^\s@<>",;:()[\]\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** "2026-05-03" as "May 3, 2026"; anything else as it is. */
function friendlyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The Step 2 answers as rows, leaving out the empty optional ones. */
function answerRows(d: Details): [string, string][] {
  const rows: [string, string][] = [
    [copy.label.title, d.title],
    [copy.label.programevent, d.programevent],
    [copy.label.subjecttype, d.subjecttype.join(", ")],
    [copy.label.date, d.date ? friendlyDate(d.date) : ""],
    [copy.label.location, d.location],
    [copy.label.eventname, d.eventname],
    [copy.label.caption, d.caption],
  ];
  return rows.filter(([, v]) => v.trim() !== "");
}

export function composeEmail(facts: EmailFacts, publicBaseUrl: string): Email {
  const link = reviewLink(publicBaseUrl, facts.submissionId);
  const who = facts.submitter;
  const name = who ? oneLine(who.name) || who.email : "";
  const counts = copy.counts(facts.sent.photos, facts.sent.videos);
  const sentCount = facts.sent.photos + facts.sent.videos;
  const title = oneLine(facts.details?.title ?? "");

  let subject: string;
  let heading: string;
  let intro: string;
  const notes: string[] = [];
  const rows: [string, string][] = [];
  if (who) rows.push([copy.label.from, `${name} (${who.email})`]);

  if (facts.kind === "unknown" || !facts.details || facts.expectedItems === undefined) {
    subject = copy.subject.unknown;
    heading = copy.heading.unknown;
    intro = copy.intro.unknown;
    if (sentCount > 0) rows.push([copy.label.arrived, counts]);
  } else if (facts.kind === "complete") {
    subject = copy.subject.complete(name, title, counts);
    heading = copy.heading.complete;
    intro = copy.intro.complete(name, counts);
    rows.push([copy.label.sent, counts]);
  } else {
    const part = copy.partCounts(sentCount, facts.expectedItems);
    subject = copy.subject.partial(name, title, part);
    heading = copy.heading.partial;
    intro = copy.intro.partial(name, part, counts);
    rows.push([copy.label.sent, copy.partRow(sentCount, facts.expectedItems, counts)]);
    if (facts.why) notes.push("finished" in facts.why ? copy.why.finished : copy.why.stalled(facts.why.stalledMinutes));
    notes.push(copy.later);
  }
  if (facts.details && facts.kind !== "unknown") rows.push(...answerRows(facts.details));
  const own = facts.kind !== "unknown" && facts.ownDetails ? copy.ownDetails(facts.ownDetails) : undefined;
  const footer = [`${copy.label.submissionId}: ${facts.submissionId}`, ...(who ? [copy.reply(name)] : []), copy.footer];

  const text = [
    heading,
    "",
    intro,
    ...(notes.length ? ["", ...notes] : []),
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(own ? ["", own] : []),
    "",
    copy.reviewText,
    link,
    "",
    ...footer,
    "",
  ].join("\n");

  const e = escapeHtml;
  const cell = "padding:6px 12px 6px 0;vertical-align:top;";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2b2622;">
<div style="background:#ffffff;border-radius:8px;padding:24px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${e(heading)}</h1>
<p style="margin:0 0 12px;">${e(intro)}</p>
${notes.map((n) => `<p style="margin:0 0 12px;color:#5c534b;">${e(n)}</p>`).join("\n")}
<table role="presentation" style="border-collapse:collapse;margin:8px 0 16px;width:100%;">
${rows.map(([k, v]) => `<tr><th scope="row" style="${cell}text-align:left;font-weight:600;white-space:nowrap;">${e(k)}</th><td style="${cell}white-space:pre-wrap;overflow-wrap:anywhere;">${e(v)}</td></tr>`).join("\n")}
</table>
${own ? `<p style="margin:0 0 16px;">${e(own)}</p>` : ""}
<p style="margin:0 0 8px;"><a href="${e(link)}" style="display:inline-block;background:#7a4a24;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px;">${e(copy.review)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#5c534b;overflow-wrap:anywhere;"><a href="${e(link)}" style="color:#7a4a24;">${e(link)}</a></p>
</div>
<p style="margin:16px 0 0;font-size:13px;color:#5c534b;">${footer.map(e).join("<br>")}</p>
</div>
</body></html>
`;

  const replyTo = who && PLAIN_ADDRESS.test(who.email) ? { name, address: who.email } : undefined;
  return { subject: oneLine(subject), text, html, ...(replyTo ? { replyTo } : {}) };
}

/** Hands one email to the relay; resolves once the relay has accepted it. */
export type Mailer = (email: Email) => Promise<void>;

export function createMailer(config: ReviewerEmail, opts: { tls?: tls.ConnectionOptions } = {}): Mailer {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // Port 587: plain to start, then STARTTLS, which must succeed (requireTLS).
    secure: false,
    requireTLS: true,
    name: config.ehloName,
    // No SMTP authentication: the relay trusts the server's IP (ADR 0006).
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    tls: { ...(isIP(config.smtpHost) ? {} : { servername: config.smtpHost }), minVersion: "TLSv1.2", ...opts.tls },
  });
  return async (email) => {
    await transport.sendMail({
      from: { name: copy.fromName, address: config.from },
      to: config.to,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      subject: email.subject,
      text: email.text,
      html: email.html,
      // So vacation responders and the like don't answer it.
      headers: { "Auto-Submitted": "auto-generated" },
    });
  };
}

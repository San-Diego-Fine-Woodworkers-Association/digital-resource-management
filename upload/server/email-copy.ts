// Every word of the Reviewers' email (#61), in one place.
//
// DRAFT: needs Isaac's read-through. The email is for Reviewers, not members,
// so #31's member-facing copy does not cover it and internal words
// (Submission, Pending Review) are fine. Plain and short, like the page.
//
// Values passed in here are plain text; reviewer-email.ts escapes them for
// the HTML part and strips line breaks from anything that goes in a header.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const emailCopy = {
  /** The sender's display name, beside no-reply@sdfwa.org (as the relay test in scripts/host-setup.sh). */
  fromName: "SDFWA Media",

  /** "12 photos, 2 videos", "1 photo", "2 videos": the subject and the body use the same words. */
  counts(photos: number, videos: number): string {
    const parts = [];
    if (photos > 0 || videos === 0) parts.push(plural(photos, "photo", "photos"));
    if (videos > 0) parts.push(plural(videos, "video", "videos"));
    return parts.join(", ");
  },
  /** "9 of 14 sent". */
  partCounts: (sent: number, expected: number) => `${sent} of ${expected} sent`,
  /** The Sent row of a partial: "9 of 14 (7 photos, 2 videos)". */
  partRow: (sent: number, expected: number, counts: string) => `${sent} of ${expected} (${counts})`,

  subject: {
    complete: (name: string, title: string, counts: string) => `New photos from ${name}: ${title} (${counts})`,
    partial: (name: string, title: string, partCounts: string) => `Partly sent: New photos from ${name}: ${title} (${partCounts})`,
    /** DRAFT: the generic notice, when the Submission's record could not be read. */
    unknown: "An incomplete Submission may be ready for review",
  },

  heading: {
    complete: "New photos to review",
    partial: "Some photos to review",
    unknown: "A Submission may be ready for review",
  },

  /** The opening line. */
  intro: {
    complete: (name: string, counts: string) => `${name} sent ${counts}.`,
    partial: (name: string, partCounts: string, counts: string) => `Not everything ${name} sent has arrived: ${partCounts} (${counts}).`,
    unknown: "Some photos or videos may be in Pending Review, but the details of what was sent could not be read, so this email can't say what they are.",
  },

  /** Why a partial email went now. */
  why: {
    finished: "The member's page finished with some not sent.",
    stalled: (minutes: number) => `Nothing more has arrived for ${minutes} minutes.`,
  },

  /** After a partial: what happens to the rest. */
  later: "If the rest arrive later, they'll be in Pending Review too. There won't be another email.",

  /** The labels of the rows. */
  label: {
    from: "From",
    sent: "Sent",
    arrived: "Arrived so far",
    title: "Title",
    programevent: "Program / Event",
    subjecttype: "Subject Type(s)",
    date: "Date",
    location: "Location",
    eventname: "Event name",
    caption: "Caption",
    submissionId: "Submission ID",
  },

  /** Items changed one by one in Step 3: a count only (#61 decision 3). */
  ownDetails: (n: number) => (n === 1 ? "1 has its own details. Open it to see them." : `${n} have their own details. Open each to see them.`),

  /** The button, and the line before the bare link in the text part. */
  review: "Open them in Pending Review",
  reviewText: "Open them in Pending Review:",

  /** The last line. */
  reply: (name: string) => `Reply to this email to reach ${name}.`,
  footer: "Sent by the upload page at media.sdfwa.org/upload. Pending Review in ResourceSpace is the full list.",
};

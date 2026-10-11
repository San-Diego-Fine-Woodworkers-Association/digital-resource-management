// Every word a member sees, in one place (issue #31), so a non-developer can
// change the wording, or a later translation can replace it, in one file.
//
// Voice: short, warm, plain. Members see "photos and videos", "send" and
// "a volunteer"; never Submission, Item, Quarantine, Reviewer or upload.

import { RIGHTS_STATEMENT } from "../shared/rights.ts";

/** "1 photo", "12 photos". Videos join in with #54/#55. */
function countWords(photos: number): string {
  return `${photos} photo${photos === 1 ? "" : "s"}`;
}

export const copy = {
  header: {
    site: "SDFWA Media",
    title: "Share your photos and videos",
    signedInAs: (name: string) => `Signed in as ${name}.`,
    notYou: "Not you?",
    signOut: "Sign out",
  },

  steps: {
    stepOf: (step: number, total: number) => `Step ${step} of ${total}`,
    titles: [
      "Choose your photos and videos",
      "Tell us about them",
      "Change any single one",
      "Sending",
    ],
  },

  choose: {
    intro: "Pick the photos and videos you'd like to share. You can choose many at once.",
    button: "Choose photos and videos",
    chosen: (photos: number) => `✓ ${countWords(photos)} chosen`,
    // Not on #31: from the prototype. Shown when the browser can't draw the
    // photo (often HEIC). Needs a read-through.
    noPreview: "Photo (preview not available)",
    // Not on #31 as a string; #56 refers to "Next". Needs a read-through.
    next: "Next",
  },

  describe: {
    requiredLegend: "means you need to fill this in",
    title: "What are these?",
    titleHint: "For example: Dovetail class, May 3",
    rights: RIGHTS_STATEMENT,
    stillNeeded: (fields: string[]) => `Still needed: ${fields.join(", ")}`,
    // Not on #31: the names the Still-needed line uses. Needs a read-through.
    neededTitle: "What are these?",
    neededRights: "Permission to share",
    send: "Send them",
  },

  sending: {
    keepOpen: "Please keep this page open and your phone awake until it says thank you.",
    progress: (sent: number, total: number) => `${sent} of ${total} sent.`,
    sending: "Sending…",
    finishing: "Finishing up…",
    sent: "✓ Sent",
    couldNotSave: "Couldn't save this one",
    tryAgain: "Try again",
    cannotAdd: "Can't be added:",
    wrongType: "This kind of file can't be added. We can take photos (JPG, PNG, HEIC) and videos (MP4, MOV).",
    remove: "Remove",
  },

  done: {
    title: (photos: number) => `Thank you! We have your ${countWords(photos)}.`,
    next: "A volunteer will take a look before they appear on the SDFWA media site.",
    nothingElse: "You don't need to do anything else, and you can close this page.",
    more: "Share more photos or videos",
  },

  notMember: {
    title: "This page is for current SDFWA members",
    signedInAs: (name: string) =>
      `You're signed in as ${name}, but we don't see a current paid membership on this account.`,
    explain:
      "If your membership has lapsed, you can renew it. If you do have a current membership under a different login, sign out and sign back in with that one.",
    renew: "Renew my membership",
    switchAccount: "Sign out and sign in again",
  },

  paused: {
    message: "Sharing is paused for a little while. Please come back later.",
  },

  // Not in the approved copy on #31: the page-load wording for an auth outage,
  // adapted from the "busy" line on #23. Needs a read-through.
  unavailable: {
    message: "We're busy right now. Please try again in a few minutes.",
    tryAgain: "Try again",
  },
} as const;

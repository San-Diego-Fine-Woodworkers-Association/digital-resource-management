// Every word a member sees, in one place (issue #31), so a non-developer can
// change the wording, or a later translation can replace it, in one file.
//
// Voice: short, warm, plain. Members see "photos and videos", "send" and
// "a volunteer"; never Submission, Item, Quarantine, Reviewer or upload.

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

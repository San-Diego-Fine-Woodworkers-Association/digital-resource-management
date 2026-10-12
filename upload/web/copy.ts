// Every word a member sees, in one place (issue #31), so a non-developer can
// change the wording, or a later translation can replace it, in one file.
//
// Voice: short, warm, plain. Members see "photos and videos", "send" and
// "a volunteer"; never Submission, Item, Quarantine, Reviewer or upload.

import type { MediaKind, Refusal } from "../shared/media.ts";
import { RIGHTS_STATEMENT } from "../shared/rights.ts";

/** "1 photo", "12 photos and 2 videos", "1 video". */
function countWords(photos: number, videos: number): string {
  const parts = [
    ...(photos || !videos ? [`${photos} photo${photos === 1 ? "" : "s"}`] : []),
    ...(videos ? [`${videos} video${videos === 1 ? "" : "s"}`] : []),
  ];
  return parts.join(" and ");
}

/** A file's size the way a phone shows it: "820 KB", "62 MB", "1.6 GB". */
export function formatSize(bytes: number): string {
  const MB = 1024 * 1024;
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Why one file can't be added (#31, #18). Each limit has its own reason. */
function refusalReason(refusal: Refusal, kind: MediaKind | undefined, size: number): string {
  switch (refusal) {
    case "wrong_type":
      return "This kind of file can't be added. We can take photos (JPG, PNG, HEIC) and videos (MP4, MOV).";
    case "too_big":
      return kind === "video"
        ? `Too big (${formatSize(size)}). Videos can be up to 1 GB. Try sending it as a shorter clip.`
        : `Too big (${formatSize(size)}). Photos can be up to 50 MB.`;
    case "too_many":
      return "That's the most we can take at once. Send this one next time.";
    // Not on #31, which has one "too many" line: the videos and total limits
    // need their own (#54). In the same pattern. Needs a read-through.
    case "too_many_videos":
      return "That's the most videos we can take at once (10). Send this one next time.";
    case "too_much_in_all":
      return "That's as much as we can take at once (4 GB in all). Send this one next time.";
  }
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
    addMore: "Add more",
    limits: "Up to 50 photos and videos at a time. Photos up to 50 MB, videos up to 1 GB.",
    chosen: (photos: number, videos: number) => `✓ ${countWords(photos, videos)} chosen`,
    howTo: "Tap one to see it bigger. Tap the ✕ to take it out.",
    couldNotAdd: "We couldn't add some files",
    refused: (name: string, reason: string) => `${name}: ${reason}`,
    reason: refusalReason,
    // Not on #31: from the prototype. Shown when the browser can't draw the
    // photo (often HEIC) or play the video. Needs a read-through.
    noPreview: "Photo (preview not available)",
    videoNoPreview: "Video (preview not available)",
    // Not on #31: the gallery's labels, from the prototype. Needs a read-through.
    gallery: "Your photos and videos",
    scrollHint: (count: number) => `Scroll to see all ${count}.`,
    video: "Video",
    seeBigger: (name: string) => `See ${name} bigger`,
    takeOut: (name: string) => `Take ${name} out`,
    bigger: (name: string) => `${name}, bigger`,
    viewerNoPreview: "This photo can't be shown here, but it will still be sent.",
    close: "Close",
    // Not on #31 as a string; #56 refers to "Next". Needs a read-through.
    next: "Next",
  },

  describe: {
    // The first sentence of #31's line; the second ("You can change any
    // single one on the next step.") comes with that step (#57).
    appliesToAll: (count: number) => `This will apply to all ${count} of them.`,
    requiredLegend: "means you need to fill this in",
    title: "What are these?",
    titleHint: "For example: Dovetail class, May 3",
    occasion: "What was the occasion?",
    subjects: "What's in them? (pick all that apply)",
    date: "When were they taken?",
    dateHint: "Leave empty if you're not sure. We'll use the date on the photo when we can.",
    location: "Where were they taken?",
    eventName: "Name of the class or event, if there is one",
    caption: "Anything else we should know?",
    rights: RIGHTS_STATEMENT,
    stillNeeded: (fields: string[]) => `Still needed: ${fields.join(", ")}`,
    // Not on #31: the names the Still-needed line uses. Needs a read-through.
    neededTitle: "What are these?",
    neededOccasion: "What was the occasion?",
    neededSubjects: "What's in them?",
    neededRights: "Permission to share",
    // Not on #31 (#56): the dropdowns' empty state and the way to empty the
    // optional one again. Needs a read-through.
    chooseOne: "Choose one",
    leaveEmpty: "Leave empty",
    // Not on #31 (#56): while the club's lists load, and when they can't.
    // Needs a read-through.
    loadingChoices: "Getting the lists of choices…",
    choicesFailed: "We couldn't get the lists of choices just now.",
    tryAgain: "Try again",
    // Not on #31 (#56): a choice removed from the club's list after the page
    // loaded, and Send failing before anything was sent. Needs a read-through.
    noLongerOffered: "That choice is no longer on the list. Please choose again.",
    choiceGone: "One of your choices is no longer on the list. Please choose again.",
    startFailed: "We couldn't start sending. Please try again.",
    send: "Send them",
  },

  sending: {
    keepOpen: "Please keep this page open and your phone awake until it says thank you.",
    progress: (sent: number, total: number) => `${sent} of ${total} sent.`,
    // Not on #31: an Item waiting its turn (two are sent at a time). Needs a read-through.
    waiting: "Waiting…",
    sending: "Sending…",
    finishing: "Finishing up…",
    // #31's line in full; only a video takes long enough to need it (#55).
    finishingVideo: "Finishing up… (videos can take a few minutes)",
    sent: "✓ Sent",
    couldNotSave: "Couldn't save this one",
    tryAgain: "Try again",
    cannotAdd: (reason: string) => `Can't be added: ${reason}`,
    remove: "Remove",
  },

  done: {
    title: (photos: number, videos: number) => `Thank you! We have your ${countWords(photos, videos)}.`,
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

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
    // need their own (#54). In the same pattern. Approved in the #54 review.
    case "too_many_videos":
      return "That's the most videos we can take at once (10). Send this one next time.";
    case "too_much_in_all":
      return "That's as much as we can take at once (4 GB in all). Send this one next time.";
    // Not on #31 (#60): a member's daily quotas, 100 photos and videos or
    // 10 GB sent in 24 hours. In the same pattern, without the numbers (they
    // can be tuned). Approved in the #60 review.
    case "too_many_today":
      return "That's the most we can take from you in one day. Please send this one tomorrow.";
    case "too_much_today":
      return "That's as much as we can take from you in one day. Please send this one tomorrow.";
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
      "Change any single one (optional)",
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
    // photo (often HEIC) or play the video. Approved in the #54 review.
    noPreview: "Photo (preview not available)",
    videoNoPreview: "Video (preview not available)",
    // Not on #31: the gallery's labels, from the prototype. Approved in the #54 review.
    gallery: "Your photos and videos",
    scrollHint: (count: number) => `Scroll to see all ${count}.`,
    video: "Video",
    seeBigger: (name: string) => `See ${name} bigger`,
    takeOut: (name: string) => `Take ${name} out`,
    bigger: (name: string) => `${name}, bigger`,
    viewerNoPreview: "This photo can't be shown here, but it will still be sent.",
    close: "Close",
    // Not on #31 as a string; #56 refers to "Next". Approved in the #56 review.
    next: "Next",
  },

  describe: {
    appliesToAll: (count: number) => `This will apply to all ${count} of them. You can change any single one on the next step.`,
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
    // Not on #31: the names the Still-needed line uses. Approved in the #56 review.
    neededTitle: "What are these?",
    neededOccasion: "What was the occasion?",
    neededSubjects: "What's in them?",
    neededRights: "Permission to share",
    // Not on #31 (#56): the dropdowns' empty state and the way to empty the
    // optional one again. Approved in the #56 review.
    chooseOne: "Choose one",
    leaveEmpty: "Leave empty",
    // Not on #31 (#56): while the club's lists load, and when they can't.
    // Approved in the #56 review.
    loadingChoices: "Getting the lists of choices…",
    choicesFailed: "We couldn't get the lists of choices just now.",
    tryAgain: "Try again",
    // Not on #31 (#56): a choice removed from the club's list after the page
    // loaded, and Send failing before anything was sent. Approved in the #56
    // review.
    noLongerOffered: "That choice is no longer on the list. Please choose again.",
    choiceGone: "One of your choices is no longer on the list. Please choose again.",
    startFailed: "We couldn't start sending. Please try again.",
  },

  change: {
    intro: "Everything will use the details you just entered.",
    optional: "This step is optional.",
    howTo: "If a photo or video needs something different, tap it to change it. Otherwise just press Send.",
    leaveEmpty: "Leave a box empty to use what you entered in the last step.",
    done: "Done",
    remove: "Remove this one",
    changed: "Changed",
    send: "Send them",
    // Not on #31 (#57): back from Step 3 to Step 2, keeping every answer and
    // every change. Approved in the #57 review.
    back: "Back",
    // Not on #31 (#57): the tile's and the dialog's names, from the
    // prototype's "Change details for ...". The tile's says when it is
    // changed, as its badge does. Approved in the #57 review.
    open: (name: string, changed: boolean) => `Change details for ${name}${changed ? " (Changed)" : ""}`,
    dialogTitle: (name: string) => `Change details for ${name}`,
    // Not on #31 (#57): a choice made for one photo or video was taken off
    // the club's list after the page loaded. In the pattern of #56's
    // choiceGone. Approved in the #57 review.
    choiceGone: (names: string[]) =>
      `A choice you made for ${names.join(", ")} is no longer on the list. Tap it to choose again, or press Send to use what you entered in the last step.`,
  },

  sending: {
    keepOpen: "Please keep this page open and your phone awake until it says thank you.",
    progress: (sent: number, total: number) => `${sent} of ${total} sent.`,
    // Not on #31: an Item waiting its turn (two are sent at a time). Approved in
    // the #54 review.
    waiting: "Waiting…",
    sending: "Sending…",
    finishing: "Finishing up…",
    // #31's line in full; only a video takes long enough to need it (#55).
    finishingVideo: "Finishing up… (videos can take a few minutes)",
    sent: "✓ Sent",
    couldNotSave: "Couldn't save this one",
    // #31's Connection trouble lines (#58): trying again by itself, then
    // waiting for the member once the automatic tries run out.
    connection: "Connection dropped. Trying again…",
    waitingForConnection: "Waiting for your connection",
    tryAgain: "Try again",
    cannotAdd: (reason: string) => `Can't be added: ${reason}`,
    remove: "Remove",
    // Not on #31 as an Item line (#60): the service is full or not answering,
    // or the member has as much going as they may. Since #59 the page keeps
    // trying by itself first (with problems.busy); this is the Item's line
    // once those tries run out, with Try again. Approved in the #60 review.
    busy: "We're busy right now. Please try again in a few minutes.",
  },

  done: {
    title: (photos: number, videos: number) => `Thank you! We have your ${countWords(photos, videos)}.`,
    next: "A volunteer will take a look before they appear on the SDFWA media site.",
    nothingElse: "You don't need to do anything else, and you can close this page.",
    // Not on #31 (#58): in place of nothingElse after "I'll do the rest
    // later", when some weren't sent. Approved in the #58 review.
    notAllSent: "The ones that didn't go through weren't sent. You can share them again any time.",
    more: "Share more photos or videos",
  },

  // #31's "Some failed" end screen (#58): shown instead of the thank-you
  // when any of them was not sent.
  someNotSent: {
    title: "Most of your photos are in.",
    notSent: (notSent: number, total: number) =>
      `${notSent} of ${total} didn't make it. Try those again now, or come back later and choose them again.`,
    tryAgain: "Try again",
    later: "I'll do the rest later",
  },

  // #31's PROBLEMS lines (#59): what holds the page part way through.
  problems: {
    signedOut: "You've been signed out. Sign in again to keep going. We'll open it in a new tab so your photos stay here.",
    signInAgain: "Sign in again",
    // The new tab, once signed in again.
    signedInTab: "You're signed in. You can close this tab.",
    busy: "We're busy right now. We'll keep trying for a few minutes.",
    offline: "No internet connection. Your photos will keep going when it comes back.",
    // Not on #31 (#59): under the not-a-member wording when the membership
    // lapses part way through, so the member knows the chosen ones wait.
    // Needs a read-through.
    notMemberStillHere:
      "Your photos and videos are still here. Once you're signed in with a current membership, come back to this page and they'll keep going.",
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

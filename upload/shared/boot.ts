// What the service tells the page when it serves it: which screen to show and
// who is signed in. The service embeds this as JSON in the HTML, so the page
// never has to ask again on load. Shared by server/ and web/.

export const BOOT_ELEMENT_ID = "boot";

export interface ShellUser {
  /** Display name, or the email when the auth service has no name. */
  name: string;
  email: string;
}

export type Boot =
  /** A paying member or a volunteer: the upload app. */
  | { screen: "app"; user: ShellUser; signOutUrl: string }
  /** Signed in, but without a `member` or `volunteer` claim. */
  | { screen: "not-member"; user: ShellUser; renewUrl: string; signOutUrl: string }
  /** The kill switch is on. */
  | { screen: "paused" }
  /** The auth service could not be asked (an outage, never "signed out"). */
  | { screen: "unavailable" };

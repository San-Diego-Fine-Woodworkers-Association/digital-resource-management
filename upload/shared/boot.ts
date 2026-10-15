// What the service tells the page when it serves it: which screen to show and
// who is signed in. The service embeds this as JSON in the HTML, so the page
// never has to ask again on load. Shared by server/ and web/.

export const BOOT_ELEMENT_ID = "boot";

/**
 * Where "Sign in again" opens, in a new tab (#59). The service gates it like
 * the page (signing in first if need be), then says the tab can be closed.
 */
export const SIGNED_IN_PATH = "/upload/signed-in";

export interface ShellUser {
  /** Display name, or the email when the auth service has no name. */
  name: string;
  email: string;
}

export type Boot =
  /**
   * A paying member or a volunteer: the upload app. `renewUrl` and
   * `switchAccountUrl` are for a membership that lapses mid-send (#59);
   * switching account comes back to the "signed-in" screen in a new tab.
   */
  | { screen: "app"; user: ShellUser; signOutUrl: string; renewUrl: string; switchAccountUrl: string }
  /** Signed in, but without a `member` or `volunteer` claim. */
  | { screen: "not-member"; user: ShellUser; renewUrl: string; signOutUrl: string }
  /**
   * Signed in again in a new tab after the session ended mid-send (#59): the
   * tab with the chosen photos carries on, so this one can be closed.
   */
  | { screen: "signed-in" }
  /** The kill switch is on. */
  | { screen: "paused" }
  /** The auth service could not be asked (an outage, never "signed out"). */
  | { screen: "unavailable" };

// Reads the boot data the service embedded in the page. Anything missing or
// unexpected shows the temporary-problem screen: never a blank page, and
// never a sign-in prompt the service didn't ask for.
import { BOOT_ELEMENT_ID, type Boot, type ShellUser } from "../shared/boot.ts";

const FALLBACK: Boot = { screen: "unavailable" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isUser(v: unknown): v is ShellUser {
  return isRecord(v) && typeof v.name === "string" && typeof v.email === "string";
}

export function readBoot(doc: Document): Boot {
  const text = doc.getElementById(BOOT_ELEMENT_ID)?.textContent;
  if (!text) return FALLBACK;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return FALLBACK;
  }
  if (!isRecord(raw)) return FALLBACK;
  switch (raw.screen) {
    case "app":
      return isUser(raw.user) &&
        typeof raw.signOutUrl === "string" &&
        typeof raw.renewUrl === "string" &&
        typeof raw.switchAccountUrl === "string"
        ? {
            screen: "app",
            user: raw.user,
            signOutUrl: raw.signOutUrl,
            renewUrl: raw.renewUrl,
            switchAccountUrl: raw.switchAccountUrl,
          }
        : FALLBACK;
    case "not-member":
      return isUser(raw.user) && typeof raw.signOutUrl === "string" && typeof raw.renewUrl === "string"
        ? { screen: "not-member", user: raw.user, renewUrl: raw.renewUrl, signOutUrl: raw.signOutUrl }
        : FALLBACK;
    case "signed-in":
      return { screen: "signed-in" };
    case "paused":
      return { screen: "paused" };
    default:
      return FALLBACK;
  }
}

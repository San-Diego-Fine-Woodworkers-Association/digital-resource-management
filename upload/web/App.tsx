// The page. Which screen shows is decided by the service when it serves the
// page (see server/app.ts); this only renders it.
import { AppLayout, FieldSizeProvider, Link } from "@sdwa/components";
import type { Boot } from "../shared/boot.ts";
import { copy } from "./copy.ts";
import type { Sender } from "./send.ts";
import { SendMedia } from "./SendMedia.tsx";
import { Page } from "./ui.tsx";

/** Used only if no sender is given: nothing can start, so nothing is lost silently. */
const noSender: Sender = {
  options: async () => ({ ok: false }),
  begin: async () => ({ ok: false, reason: "failed" }),
  session: async () => "unknown",
};

export function App({ boot, sender = noSender }: { boot: Boot; sender?: Sender }) {
  // Light theme only in v1 (issue #31). Every control is the design system's
  // large size: 48 px touch targets and bigger text for this audience (#31).
  return (
    <AppLayout theme="light">
      <FieldSizeProvider size="large">{screenFor(boot, sender)}</FieldSizeProvider>
    </AppLayout>
  );
}

function screenFor(boot: Boot, sender: Sender) {
  switch (boot.screen) {
    case "app":
      return (
        <Page user={boot.user} signOutUrl={boot.signOutUrl}>
          <SendMedia
            sender={sender}
            account={{ user: boot.user, renewUrl: boot.renewUrl, switchAccountUrl: boot.switchAccountUrl }}
          />
        </Page>
      );
    case "not-member":
      return (
        <Page user={boot.user} signOutUrl={boot.signOutUrl}>
          <section className="flex flex-col gap-4">
            <h2 className="text-2xl font-bold">{copy.notMember.title}</h2>
            <p className="text-lg">{copy.notMember.signedInAs(boot.user.name)}</p>
            <p className="text-lg">{copy.notMember.explain}</p>
            <Link variant="primary" className="w-full" href={boot.renewUrl}>
              {copy.notMember.renew}
            </Link>
            <Link variant="secondary" className="w-full" href={boot.signOutUrl}>
              {copy.notMember.switchAccount}
            </Link>
          </section>
        </Page>
      );
    case "signed-in":
      return (
        <Page>
          <p className="text-lg">{copy.problems.signedInTab}</p>
        </Page>
      );
    case "paused":
      return (
        <Page>
          <p className="text-lg">{copy.paused.message}</p>
        </Page>
      );
    case "unavailable":
      return (
        <Page>
          <p className="text-lg">{copy.unavailable.message}</p>
          <Link variant="primary" className="w-full" href="/upload/">
            {copy.unavailable.tryAgain}
          </Link>
        </Page>
      );
  }
}

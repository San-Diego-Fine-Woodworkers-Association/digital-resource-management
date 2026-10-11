// The page. Which screen shows is decided by the service when it serves the
// page (see server/app.ts); this only renders it.
import { AppLayout } from "@sdwa/components";
import type { Boot } from "../shared/boot.ts";
import { copy } from "./copy.ts";
import type { Sender } from "./send.ts";
import { SendPhoto } from "./SendPhoto.tsx";
import { BigLink, Page } from "./ui.tsx";

/** Used only if no sender is given: every send fails, so nothing is lost silently. */
const noSender: Sender = { send: async () => ({ ok: false, reason: "failed" }) };

export function App({ boot, sender = noSender }: { boot: Boot; sender?: Sender }) {
  // Light theme only in v1 (issue #31).
  return <AppLayout theme="light">{screenFor(boot, sender)}</AppLayout>;
}

function screenFor(boot: Boot, sender: Sender) {
  switch (boot.screen) {
    case "app":
      return (
        <Page user={boot.user} signOutUrl={boot.signOutUrl}>
          <SendPhoto sender={sender} />
        </Page>
      );
    case "not-member":
      return (
        <Page user={boot.user} signOutUrl={boot.signOutUrl}>
          <section className="flex flex-col gap-4">
            <h2 className="text-2xl font-bold">{copy.notMember.title}</h2>
            <p className="text-lg">{copy.notMember.signedInAs(boot.user.name)}</p>
            <p className="text-lg">{copy.notMember.explain}</p>
            <BigLink variant="primary" href={boot.renewUrl}>
              {copy.notMember.renew}
            </BigLink>
            <BigLink variant="secondary" href={boot.signOutUrl}>
              {copy.notMember.switchAccount}
            </BigLink>
          </section>
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
          <BigLink variant="primary" href="/upload/">
            {copy.unavailable.tryAgain}
          </BigLink>
        </Page>
      );
  }
}

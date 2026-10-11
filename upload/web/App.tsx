// The page. Which screen shows is decided by the service when it serves the
// page (see server/app.ts); this only renders it.
import { AppLayout } from "@sdwa/components";
import type { Boot } from "../shared/boot.ts";
import { copy } from "./copy.ts";
import { BigLink, Page, StepFrame } from "./ui.tsx";

export function App({ boot }: { boot: Boot }) {
  // Light theme only in v1 (issue #31).
  return <AppLayout theme="light">{screenFor(boot)}</AppLayout>;
}

function screenFor(boot: Boot) {
  switch (boot.screen) {
    case "app":
      return (
        <Page user={boot.user} signOutUrl={boot.signOutUrl}>
          <StepFrame step={0}>
            <p className="text-lg">{copy.choose.intro}</p>
          </StepFrame>
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

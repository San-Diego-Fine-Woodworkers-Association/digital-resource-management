// The friendly 403 for signed-in people without a paying member / volunteer claim.
import { Page, BigButton } from "./ui";

export function Forbidden() {
  return (
    <Page>
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">This page is for current SDFWA members</h2>
        <p className="text-lg">You're signed in as <strong>Pat Member</strong>, but we don't see a current paid membership on this account.</p>
        <p className="text-lg">If your membership has lapsed, you can renew it. If you do have a current membership under a different login, sign out and sign back in with that one.</p>
        <BigButton>Renew my membership</BigButton>
        <BigButton variant="secondary">Sign out and sign in again</BigButton>
      </div>
    </Page>
  );
}

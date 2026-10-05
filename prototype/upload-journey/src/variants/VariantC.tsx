// VARIANT C: "Send as you go". Uploading starts the moment files are chosen;
// the member describes them while they send. Details form is above the fold,
// progress + Finish live in a bottom bar. Per-Item changes open in a pop-up.
import { useState } from "react";
import { Button as PressTarget, Dialog as RACDialog, DialogTrigger } from "react-aria-components";
import { Modal, ModalOverlay, Notification } from "@sdwa/components";
import { useSubmission, countWords } from "../lib/useSubmission";
import { missing } from "../lib/fields";
import { LIMITS_SENTENCE } from "../lib/limits";
import { BigButton, Bar, Done, MetaFields, Page, PickFilesButton, StatusText, Thumb } from "../ui";

export function VariantC({ flaky }: { flaky: boolean }) {
  const s = useSubmission({ flaky, autoStart: true });
  const [finished, setFinished] = useState(false);
  // Modals portal outside the themed container; pass a container so tokens apply.
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const need = missing(s.batch);
  const sending = s.items.length - s.doneCount;
  const retrying = s.items.some((i) => i.status === "retrying");
  const blockers = [
    sending > 0 ? `${sending} still sending` : null,
    need.length ? `please fill in: ${need.join("; ")}` : null,
  ].filter(Boolean);

  if (finished && s.allDone) return <Page><Done photos={s.photos} videos={s.videos} onMore={() => { s.reset(); setFinished(false); }} /></Page>;

  return (
    <Page>
      <div ref={setPortal} />
      {s.items.length === 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-lg">Choose the photos and videos you'd like to share. They start sending right away, while you tell us about them.</p>
          <PickFilesButton onSelect={s.addFiles} />
          <p className="text-muted-foreground">{LIMITS_SENTENCE}</p>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-bold">Tell us about your {countWords(s.photos, s.videos)}</h2>
            <MetaFields value={s.batch} onChange={(p) => s.setBatch({ ...s.batch, ...p } as typeof s.batch)} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-bold">Your photos and videos</h2>
            <p className="text-muted-foreground">Tap one to change its details or remove it.</p>
            <ul className="flex gap-3 overflow-x-auto pb-2">
              {s.items.map((i) => (
                <li key={i.id} className="w-32 shrink-0">
                  <DialogTrigger>
                    {/* DialogTrigger only wires press events into react-aria pressables, so a plain <button> won't open it. */}
                    <PressTarget className="flex w-full flex-col gap-1 text-left outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring" aria-label={`Details for ${i.file.name}`}>
                      <Thumb item={i} className="aspect-square w-full rounded-lg" />
                      <Bar value={i.progress} label={i.file.name} />
                      <span className="text-sm"><StatusText item={i} /></span>
                      <span className="text-sm font-medium underline">Change or remove</span>
                    </PressTarget>
                    <ModalOverlay UNSTABLE_portalContainer={portal ?? undefined}>
                      <Modal>
                        <RACDialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto outline-none" aria-label={`Details for ${i.file.name}`}>
                          {({ close }) => (
                            <>
                              <Thumb item={i} className="aspect-[4/3] w-full rounded-lg" />
                              <p className="truncate font-medium">{i.file.name}</p>
                              <MetaFields override showPermission={false} value={i.overrides} onChange={(p) => s.setOverride(i.id, p)} />
                              <BigButton onPress={close}>Done</BigButton>
                              <BigButton variant="quiet" onPress={() => { s.remove(i.id); close(); }}>Remove this one</BigButton>
                            </>
                          )}
                        </RACDialog>
                      </Modal>
                    </ModalOverlay>
                  </DialogTrigger>
                </li>
              ))}
            </ul>
            <PickFilesButton onSelect={s.addFiles} label="Add more" variant="secondary" />
            {s.rejected.length > 0 && (
              <Notification variant="warning" title="We couldn't add some files">
                <ul className="list-disc pl-5">{s.rejected.map((r) => <li key={r.name}><strong>{r.name}</strong>: {r.reason}</li>)}</ul>
              </Notification>
            )}
          </section>

          {/* Bottom bar: overall progress, plain-language status, Finish. */}
          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background p-3">
            <div className="mx-auto flex w-full max-w-xl flex-col gap-2">
              <Bar value={s.overall} label="All uploads" />
              <p className="text-center text-sm" aria-live="polite">
                {retrying ? (
                  <span className="font-medium text-warning">Your connection dropped for a moment. Trying again, nothing is lost.</span>
                ) : s.allDone ? (
                  <span className="font-medium text-success">✓ All {s.items.length} sent</span>
                ) : (
                  <span>Sending… {s.doneCount} of {s.items.length} done. Please keep this page open.</span>
                )}
              </p>
              {blockers.length > 0 && !s.allDone && <p className="text-center text-sm text-muted-foreground">To finish: {blockers.join(", and ")}.</p>}
              {s.allDone && need.length > 0 && <p className="text-center text-sm text-muted-foreground">To finish, please fill in: {need.join("; ")}.</p>}
              <BigButton isDisabled={blockers.length > 0} onPress={() => setFinished(true)}>Finish</BigButton>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

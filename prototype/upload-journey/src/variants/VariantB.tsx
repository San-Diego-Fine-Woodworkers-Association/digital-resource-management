// VARIANT B: "Guided steps". One question per screen, big Back / Next bar,
// "Step 2 of 4". Chosen as the direction; flow revised after first feedback:
//  - Step 1: every item in a 3-column scrolling gallery (max 4 rows visible),
//    a remove button per tile, tap a tile to see it full size.
//  - Step 3: same gallery; tap any item to change its details (optional),
//    the dialog is prefilled with what was entered in Step 2.
import { useState, type ReactNode } from "react";
import { Button as PressTarget, Dialog as RACDialog, DialogTrigger } from "react-aria-components";
import { Modal, ModalOverlay, Notification } from "@sdwa/components";
import { useSubmission, countWords, effective, type Item, type Submission } from "../lib/useSubmission";
import { missing } from "../lib/fields";
import { LIMITS_SENTENCE } from "../lib/limits";
import { BigButton, Bar, Done, FullMedia, MetaFields, Page, PickFilesButton, StatusText, Thumb } from "../ui";

const TITLES = ["Choose your photos and videos", "Tell us about them", "Change any single one", "Sending"];

// 3 columns, at most 4 rows tall before it scrolls. Container query units keep
// the 4-row height right at any width (cell = (width - 2 gaps) / 3).
function Gallery({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="@container">
        <ul className="grid max-h-[calc((100cqw-1rem)/3*4+1.5rem)] grid-cols-3 gap-2 overflow-y-auto rounded-lg border border-border p-0" aria-label="Your photos and videos">
          {children}
        </ul>
      </div>
      {count > 12 && <p className="text-sm text-muted-foreground">Scroll to see all {count}.</p>}
    </div>
  );
}

function Viewer({ item, portal }: { item: Item; portal: HTMLElement | null }) {
  return (
    <ModalOverlay isDismissable UNSTABLE_portalContainer={portal ?? undefined}>
      <Modal className="max-w-3xl p-3">
        <RACDialog className="flex max-h-[90vh] flex-col gap-3 overflow-y-auto outline-none" aria-label={`Bigger view of ${item.file.name}`}>
          {({ close }) => (
            <>
              <FullMedia item={item} />
              <p className="truncate text-center text-sm text-muted-foreground">{item.file.name}</p>
              <BigButton onPress={close}>Close</BigButton>
            </>
          )}
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}

// Dialog body for changing one Item. Prefilled from Step 2 (plus any earlier
// change). Emptying a box means "use what I entered in Step 2".
function ChangeDialog({ item, s, close }: { item: Item; s: Submission; close: () => void }) {
  const [draft, setDraft] = useState(() => effective(item, s.batch));
  return (
    <>
      <Thumb item={item} className="aspect-[4/3] w-full rounded-lg" />
      <p className="truncate font-medium">{item.file.name}</p>
      <MetaFields
        override prefilled showPermission={false}
        value={draft}
        onChange={(p) => {
          setDraft({ ...draft, ...p });
          const [k, v] = Object.entries(p)[0] as [keyof typeof draft, string];
          s.setOverride(item.id, { [k]: v === "" ? undefined : v });
        }}
      />
      <p className="text-sm text-muted-foreground">Leave a box empty to use what you entered in the last step.</p>
      <BigButton onPress={close}>Done</BigButton>
      <BigButton variant="quiet" onPress={() => { s.remove(item.id); close(); }}>Remove this one</BigButton>
    </>
  );
}

export function VariantB({ flaky }: { flaky: boolean }) {
  const s = useSubmission({ flaky, autoStart: false });
  const [step, setStep] = useState(0);
  // Modals portal outside the themed container; pass a container so tokens apply.
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const need = missing(s.batch);

  if (s.allDone) return <Page><Done photos={s.photos} videos={s.videos} onMore={() => { s.reset(); setStep(0); }} /></Page>;

  const canNext = step === 0 ? s.items.length > 0 : step === 1 ? need.length === 0 : true;
  const next = () => { if (step === 2) s.start(); setStep(step + 1); };

  return (
    <Page>
      <div ref={setPortal} />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">Step {step + 1} of 4</p>
        <div className="flex gap-1" aria-hidden>{[0, 1, 2, 3].map((n) => <div key={n} className={`h-2 flex-1 rounded-full ${n <= step ? "bg-primary" : "bg-secondary"}`} />)}</div>
        <h2 className="pt-2 text-2xl font-bold">{TITLES[step]}{step === 2 && <span className="text-lg font-normal text-muted-foreground"> (optional)</span>}</h2>
      </div>

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <p className="text-lg">Pick the photos and videos you'd like to share. You can choose many at once.</p>
          <PickFilesButton onSelect={s.addFiles} label={s.items.length ? "Add more" : "Choose photos and videos"} variant={s.items.length ? "secondary" : "primary"} />
          <p className="text-muted-foreground">{LIMITS_SENTENCE}</p>
          {s.rejected.length > 0 && (
            <Notification variant="warning" title="We couldn't add some files">
              <ul className="list-disc pl-5">{s.rejected.map((r) => <li key={r.name}><strong>{r.name}</strong>: {r.reason}</li>)}</ul>
            </Notification>
          )}
          {s.items.length > 0 && (
            <>
              <p className="text-lg font-medium">✓ {countWords(s.photos, s.videos)} chosen</p>
              <p className="text-muted-foreground">Tap one to see it bigger. Tap the ✕ to take it out.</p>
              <Gallery count={s.items.length}>
                {s.items.map((i) => (
                  <li key={i.id} className="relative">
                    <DialogTrigger>
                      <PressTarget className="block w-full outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring" aria-label={`See ${i.file.name} bigger`}>
                        <Thumb item={i} className="aspect-square w-full" />
                      </PressTarget>
                      <Viewer item={i} portal={portal} />
                    </DialogTrigger>
                    <PressTarget
                      aria-label={`Remove ${i.file.name}`}
                      onPress={() => s.remove(i.id)}
                      className="absolute right-1 top-1 flex size-10 items-center justify-center rounded-full bg-black/75 text-xl text-white outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
                    >✕</PressTarget>
                  </li>
                ))}
              </Gallery>
            </>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          <p className="text-lg">This will apply to all {s.items.length} of them. You can change any single one on the next step.</p>
          <MetaFields value={s.batch} onChange={(p) => s.setBatch({ ...s.batch, ...p } as typeof s.batch)} />
          {need.length > 0 && <p className="text-muted-foreground">Still needed: {need.join("; ")}.</p>}
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="text-lg">Everything will use the details you just entered. <strong>This step is optional.</strong> If a photo or video needs something different, tap it to change it. Otherwise just press Send.</p>
          <Gallery count={s.items.length}>
            {s.items.map((i) => {
              const changed = Object.values(i.overrides).some(Boolean);
              return (
                <li key={i.id} className="relative">
                  <DialogTrigger>
                    <PressTarget className="block w-full outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring" aria-label={`Change details for ${i.file.name}`}>
                      <Thumb item={i} className="aspect-square w-full" />
                    </PressTarget>
                    <ModalOverlay isDismissable UNSTABLE_portalContainer={portal ?? undefined}>
                      <Modal>
                        <RACDialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto outline-none" aria-label={`Change details for ${i.file.name}`}>
                          {({ close }) => <ChangeDialog item={i} s={s} close={close} />}
                        </RACDialog>
                      </Modal>
                    </ModalOverlay>
                  </DialogTrigger>
                  {changed && <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-primary px-2 text-sm text-primary-foreground">Changed</span>}
                </li>
              );
            })}
          </Gallery>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <p className="text-lg">Please keep this page open until it says thank you.</p>
          <Bar value={s.overall} label="All uploads" />
          <p className="font-medium">{s.doneCount} of {s.items.length} sent</p>
          <ul className="flex flex-col gap-3">
            {s.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3">
                <Thumb item={i} className="size-14 shrink-0 rounded" />
                <div className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate text-sm">{i.file.name}</span><Bar value={i.progress} label={i.file.name} /><StatusText item={i} /></div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step < 3 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background p-3">
          <div className="mx-auto flex max-w-xl gap-3">
            {step > 0 && <BigButton variant="secondary" className="flex-1" onPress={() => setStep(step - 1)}>Back</BigButton>}
            <BigButton className="flex-[2]" isDisabled={!canNext} onPress={next}>{step === 2 ? "Send them" : "Next"}</BigButton>
          </div>
        </div>
      )}
    </Page>
  );
}

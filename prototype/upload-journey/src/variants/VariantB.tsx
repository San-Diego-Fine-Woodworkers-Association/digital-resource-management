// VARIANT B: "Guided steps". One question per screen, big Back / Next bar,
// "Step 2 of 4". Per-Item checking is its own step, one Item at a time.
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Notification } from "@sdwa/components";
import { useSubmission, countWords, effective } from "../lib/useSubmission";
import { missing, FIELD_LABELS } from "../lib/fields";
import { LIMITS_SENTENCE } from "../lib/limits";
import { BigButton, Bar, Done, MetaFields, Page, PickFilesButton, StatusText, Thumb } from "../ui";

const TITLES = ["Choose your photos and videos", "Tell us about them", "Check each one", "Sending"];

export function VariantB({ flaky }: { flaky: boolean }) {
  const s = useSubmission({ flaky, autoStart: false });
  const [step, setStep] = useState(0);
  const [idx, setIdx] = useState(0);
  const need = missing(s.batch);

  if (s.allDone) return <Page><Done photos={s.photos} videos={s.videos} onMore={() => { s.reset(); setStep(0); setIdx(0); }} /></Page>;

  const canNext = step === 0 ? s.items.length > 0 : step === 1 ? need.length === 0 : true;
  const item = s.items[Math.min(idx, s.items.length - 1)];

  const next = () => { if (step === 2) s.start(); setStep(step + 1); };

  return (
    <Page>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">Step {step + 1} of 4</p>
        <div className="flex gap-1" aria-hidden>{[0, 1, 2, 3].map((n) => <div key={n} className={`h-2 flex-1 rounded-full ${n <= step ? "bg-primary" : "bg-secondary"}`} />)}</div>
        <h2 className="pt-2 text-2xl font-bold">{TITLES[step]}</h2>
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
          {s.items.length > 0 && <p className="text-lg font-medium">✓ {countWords(s.photos, s.videos)} chosen</p>}
          <div className="grid grid-cols-4 gap-2">{s.items.slice(0, 12).map((i) => <Thumb key={i.id} item={i} className="aspect-square w-full rounded" />)}</div>
          {s.items.length > 12 && <p className="text-muted-foreground">…and {s.items.length - 12} more</p>}
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          <p className="text-lg">This will apply to all {s.items.length} of them. You can change any single one on the next step.</p>
          <MetaFields value={s.batch} onChange={(p) => s.setBatch({ ...s.batch, ...p } as typeof s.batch)} />
          {need.length > 0 && <p className="text-muted-foreground">Still needed: {need.join("; ")}.</p>}
        </div>
      )}

      {step === 2 && item && (
        <div className="flex flex-col gap-4">
          <p className="text-lg font-medium">{item.kind === "photo" ? "Photo" : "Video"} {idx + 1} of {s.items.length}</p>
          <Thumb item={item} className="aspect-[4/3] w-full rounded-lg" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
            {(["description", "event", "date", "people"] as const).map((k) => (
              <div key={k} className="contents"><dt className="text-muted-foreground">{FIELD_LABELS[k]}</dt><dd>{effective(item, s.batch)[k] || "—"}</dd></div>
            ))}
          </dl>
          <Collapsible>
            <CollapsibleTrigger>Change this one</CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <MetaFields override showPermission={false} value={item.overrides} onChange={(p) => s.setOverride(item.id, p)} />
            </CollapsibleContent>
          </Collapsible>
          <div className="flex gap-3">
            <BigButton variant="secondary" className="flex-1" isDisabled={idx === 0} onPress={() => setIdx(idx - 1)}>Previous</BigButton>
            <BigButton variant="secondary" className="flex-1" isDisabled={idx >= s.items.length - 1} onPress={() => setIdx(idx + 1)}>Next one</BigButton>
          </div>
          <BigButton variant="quiet" onPress={next}>They all look right: skip to sending</BigButton>
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

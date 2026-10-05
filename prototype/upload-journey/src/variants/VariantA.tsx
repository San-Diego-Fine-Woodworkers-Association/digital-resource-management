// VARIANT A: "One page". Everything on a single scrolling page, in 3 numbered
// sections. Upload starts only when the member presses Send.
import { Card, CardContent, Collapsible, CollapsibleContent, CollapsibleTrigger, Notification } from "@sdwa/components";
import { useSubmission, countWords } from "../lib/useSubmission";
import { missing } from "../lib/fields";
import { LIMITS_SENTENCE, formatSize } from "../lib/limits";
import { BigButton, Bar, Done, MetaFields, Page, PickFilesButton, StatusText, Thumb } from "../ui";

export function VariantA({ flaky }: { flaky: boolean }) {
  const s = useSubmission({ flaky, autoStart: false });
  const need = missing(s.batch);
  const canSend = s.items.length > 0 && need.length === 0 && !s.started;

  if (s.allDone) return <Page><Done photos={s.photos} videos={s.videos} onMore={s.reset} /></Page>;

  return (
    <Page>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">1. Choose your photos and videos</h2>
        <p className="text-muted-foreground">{LIMITS_SENTENCE}</p>
        {!s.started && <PickFilesButton onSelect={s.addFiles} label={s.items.length ? "Add more" : "Choose photos and videos"} variant={s.items.length ? "secondary" : "primary"} />}
        {s.rejected.length > 0 && (
          <Notification variant="warning" title="We couldn't add some files">
            <ul className="list-disc pl-5">
              {s.rejected.map((r) => <li key={r.name}><strong>{r.name}</strong>: {r.reason}</li>)}
            </ul>
          </Notification>
        )}
        {s.items.length > 0 && <p className="font-medium">You've chosen {countWords(s.photos, s.videos)}.</p>}
        <div className="grid grid-cols-2 gap-3">
          {s.items.map((i) => (
            <Card key={i.id}>
              <CardContent className="flex flex-col gap-2 p-2">
                <Thumb item={i} className="aspect-square w-full rounded" />
                <p className="truncate text-sm">{i.file.name} · {formatSize(i.file.size)}</p>
                {s.started ? (
                  <><Bar value={i.progress} label={`Sending ${i.file.name}`} /><StatusText item={i} /></>
                ) : (
                  <>
                    <Collapsible>
                      <CollapsibleTrigger>Change details</CollapsibleTrigger>
                      <CollapsibleContent className="pt-3">
                        <MetaFields override showPermission={false} value={i.overrides} onChange={(p) => s.setOverride(i.id, p)} />
                      </CollapsibleContent>
                    </Collapsible>
                    <BigButton variant="quiet" className="min-h-10 text-base" onPress={() => s.remove(i.id)}>Remove</BigButton>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">2. Tell us about them</h2>
        <p className="text-muted-foreground">This applies to all of them. You can change a single photo or video above.</p>
        <MetaFields value={s.batch} onChange={(p) => s.setBatch({ ...s.batch, ...p } as typeof s.batch)} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">3. Send</h2>
        {s.started ? (
          <><Bar value={s.overall} label="All uploads" /><p className="font-medium">Sending… {s.doneCount} of {s.items.length} done. Please keep this page open.</p></>
        ) : (
          <>
            {!canSend && <p className="text-muted-foreground">{s.items.length === 0 ? "Choose some photos or videos first." : `Still needed: ${need.join("; ")}.`}</p>}
            <BigButton isDisabled={!canSend} onPress={s.start}>
              {s.items.length ? `Send ${countWords(s.photos, s.videos)}` : "Send"}
            </BigButton>
          </>
        )}
      </section>
    </Page>
  );
}

// The journey: choose photos and videos (many at once, #54), describe them
// all once (#56), change any single one (optional, #57), Send, thank-you
// (#53). The full set of Item states and retries (#58, #59) build on this.
import { useEffect, useRef, useState } from "react";
import { Button, FilePickerButton, Notification, ProgressBar } from "@sdwa/components";
import { changedFields, NO_DETAILS, withChanges, type Changes, type DetailField, type Details } from "../shared/details.ts";
import type { Refusal } from "../shared/media.ts";
import { Change } from "./Change.tsx";
import { choose, type Chosen, type Refused } from "./choose.ts";
import { copy } from "./copy.ts";
import { Describe, type OptionsState } from "./Describe.tsx";
import { Gallery, Thumb } from "./Gallery.tsx";
import type { Sender, Submission } from "./send.ts";
import { StepFrame } from "./ui.tsx";

/**
 * What the picker offers: JPEG, PNG, HEIC/HEIF, MP4 and MOV (#18). This only
 * filters the picker; each file is then checked by its content (choose.ts),
 * and again by the service.
 */
const ACCEPTED = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".mp4",
  ".mov",
];

/** How many are sent at once (#54). */
const AT_ONCE = 2;

type Step = "choose" | "describe" | "change" | "sending" | "done";

type ItemState =
  | { status: "waiting" }
  | { status: "sending"; percent: number }
  | { status: "finishing" }
  | { status: "sent" }
  | { status: "failed" }
  | { status: "refused"; refusal: Refusal };

function counts(items: Chosen[]) {
  const videos = items.filter((i) => i.kind === "video").length;
  return { photos: items.length - videos, videos };
}

export function SendMedia({ sender }: { sender: Sender }) {
  const [step, setStep] = useState<Step>("choose");
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [refused, setRefused] = useState<Refused[]>([]);
  const [details, setDetails] = useState<Details>(NO_DETAILS);
  const [rights, setRights] = useState(false);
  // Step 2: the club's lists, fetched when the page loads; choices the
  // service said are gone; whether Send is starting or could not.
  const [options, setOptions] = useState<OptionsState>({ status: "loading" });
  const [gone, setGone] = useState<DetailField[]>([]);
  // Step 3: what each one changed, by key, and any of those choices the
  // service said are gone.
  const [changes, setChanges] = useState<Record<string, Changes>>({});
  const [goneFor, setGoneFor] = useState<Record<string, DetailField[]>>({});
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  // Focus follows the member to each new step, but not on first load.
  const [moved, setMoved] = useState(false);
  const submission = useRef<Submission>(undefined);
  const inFlight = useRef(new Set<string>());

  const go = (next: Step) => {
    setMoved(true);
    setStep(next);
  };

  const setState = (key: string, state: ItemState) => setStates((s) => ({ ...s, [key]: state }));

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    const { added, refused } = await choose(chosen, Array.from(files));
    setChosen((c) => [...c, ...added]);
    setRefused(refused);
  }

  const remove = (key: string) => {
    setChosen((c) => c.filter((i) => i.key !== key));
    setStates(({ [key]: _gone, ...rest }) => rest);
    setChanges(({ [key]: _gone, ...rest }) => rest);
    setGoneFor(({ [key]: _gone, ...rest }) => rest);
  };

  const change = (key: string, next: Changes) => {
    // A field the member changes is no longer marked as gone.
    const before = changes[key] ?? {};
    setGoneFor((g) => {
      const still = (g[key] ?? []).filter((f) => JSON.stringify(next[f]) === JSON.stringify(before[f]));
      const { [key]: _old, ...rest } = g;
      return still.length > 0 ? { ...rest, [key]: still } : rest;
    });
    setChanges((c) => ({ ...c, [key]: next }));
  };

  const loadOptions = () => {
    setOptions({ status: "loading" });
    sender
      .options()
      .catch(() => ({ ok: false as const }))
      .then((result) => setOptions(result.ok ? { status: "ready", options: result.options } : { status: "failed" }));
  };
  useEffect(loadOptions, [sender]);

  const describe = (next: Details) => {
    // A field the member changes is no longer marked as gone.
    setGone((g) => g.filter((f) => JSON.stringify(next[f]) === JSON.stringify(details[f])));
    setDetails(next);
  };

  function start(item: Chosen) {
    const s = submission.current;
    if (!s) return;
    inFlight.current.add(item.key);
    setState(item.key, { status: "sending", percent: 0 });
    s.send(
      item.file,
      {
        onProgress: (percent) =>
          setStates((all) => (all[item.key]?.status === "sending" ? { ...all, [item.key]: { status: "sending", percent } } : all)),
        onFinishing: () => setState(item.key, { status: "finishing" }),
      },
      item.key,
    )
      .catch(() => ({ ok: false as const, reason: "failed" as const }))
      .then((result) => {
        inFlight.current.delete(item.key);
        setState(
          item.key,
          result.ok ? { status: "sent" } : result.reason === "failed" ? { status: "failed" } : { status: "refused", refusal: result.reason },
        );
      });
  }

  // Two at a time: whenever one finishes, the next waiting one starts.
  useEffect(() => {
    if (step !== "sending") return;
    for (const item of chosen) {
      if (inFlight.current.size >= AT_ONCE) break;
      if (states[item.key]?.status === "waiting" && !inFlight.current.has(item.key)) start(item);
    }
    // Everything still chosen has been sent: the thank-you.
    if (chosen.length > 0 && chosen.every((i) => states[i.key]?.status === "sent")) go("done");
  }, [step, chosen, states]);

  /** Each one changed in Step 3, by key, with only what it changes. */
  function itemChanges(): Record<string, Changes> {
    const items: Record<string, Changes> = {};
    for (const { key } of chosen) {
      const fields = changedFields(details, changes[key]);
      if (fields.length === 0) continue;
      const item = withChanges(details, changes[key]);
      items[key] = Object.fromEntries(fields.map((f) => [f, item[f]]));
    }
    return items;
  }

  async function send() {
    if (step !== "change" || starting) return;
    setStarting(true);
    setStartFailed(false);
    const items = itemChanges();
    const result = await sender
      .begin({ expectedItems: chosen.length, details, ...(Object.keys(items).length ? { items } : {}), rightsConfirmed: true })
      .catch(() => ({ ok: false as const, reason: "failed" as const }));
    setStarting(false);
    if (result.ok) {
      submission.current = result.submission;
      setStates(Object.fromEntries(chosen.map((i) => [i.key, { status: "waiting" } as ItemState])));
      go("sending");
      return;
    }
    const gonePs = result.reason === "invalid" ? result.problems.filter((p) => p.problem === "not_offered") : [];
    if (gonePs.length === 0) {
      setStartFailed(true);
      return;
    }
    // A choice was taken off the club's list after the page loaded: show the
    // lists as they are now and ask again for what is gone.
    const now = result.reason === "invalid" ? result.options : undefined;
    if (now) setOptions({ status: "ready", options: now });
    const forAll = gonePs.filter((p) => !("item" in p)).map((p) => p.field);
    if (forAll.length > 0) {
      // One of the Step 2 answers: back to Step 2 for it.
      setGone(forAll);
      setDetails((d) => ({
        ...d,
        ...(forAll.includes("programevent") ? { programevent: "" } : {}),
        ...(forAll.includes("location") ? { location: "" } : {}),
        ...(forAll.includes("subjecttype") ? { subjecttype: now ? d.subjecttype.filter((s) => now.subjecttype.includes(s)) : [] } : {}),
      }));
      go("describe");
      return;
    }
    // One single photo's or video's own: it goes back to the Step 2 answer
    // for that question, marked, until the member chooses again or sends.
    const byItem: Record<string, DetailField[]> = {};
    for (const p of gonePs) if ("item" in p) (byItem[p.item] ??= []).push(p.field);
    setGoneFor(byItem);
    setChanges((c) => {
      const next = { ...c };
      for (const [key, fields] of Object.entries(byItem)) {
        next[key] = Object.fromEntries(Object.entries(c[key] ?? {}).filter(([f]) => !fields.includes(f as DetailField)));
      }
      return next;
    });
  }

  const startOver = () => {
    submission.current = undefined;
    setChosen([]);
    setRefused([]);
    setStates({});
    setDetails(NO_DETAILS);
    setRights(false);
    setGone([]);
    setChanges({});
    setGoneFor({});
    setStartFailed(false);
    go("choose");
  };

  // Every Item was taken out while sending: back to the start. Taken out in
  // Step 3: back to choosing, keeping the answers.
  useEffect(() => {
    if (step === "sending" && chosen.length === 0) startOver();
    if (step === "change" && chosen.length === 0) go("choose");
  }, [step, chosen.length]);

  switch (step) {
    case "choose": {
      const { photos, videos } = counts(chosen);
      return (
        <StepFrame step={0} focusHeading={moved}>
          <p className="text-lg">{copy.choose.intro}</p>
          <FilePickerButton
            variant={chosen.length ? "secondary" : "primary"}
           
            className="w-full"
            acceptedFileTypes={ACCEPTED}
            allowsMultiple
            onSelect={(files) => void pick(files)}
          >
            {chosen.length ? copy.choose.addMore : copy.choose.button}
          </FilePickerButton>
          <p className="text-base text-muted-foreground">{copy.choose.limits}</p>
          {refused.length > 0 && (
            <Notification variant="warning" title={copy.choose.couldNotAdd}>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-base">
                {refused.map((r, i) => (
                  <li key={i}>{copy.choose.refused(r.name, copy.choose.reason(r.refusal, r.kind, r.size))}</li>
                ))}
              </ul>
            </Notification>
          )}
          {chosen.length > 0 && (
            <>
              <div className="flex flex-col gap-1">
                <p className="text-lg font-medium">{copy.choose.chosen(photos, videos)}</p>
                <p className="text-base text-muted-foreground">{copy.choose.howTo}</p>
              </div>
              <Gallery items={chosen} onRemove={remove} />
              <Button variant="primary" className="w-full" onPress={() => go("describe")}>
                {copy.choose.next}
              </Button>
            </>
          )}
        </StepFrame>
      );
    }

    case "describe":
      return (
        <Describe
          count={chosen.length}
          details={details}
          onChange={describe}
          rights={rights}
          onRights={setRights}
          options={options}
          onRetryOptions={loadOptions}
          gone={gone}
          onNext={() => {
            setStartFailed(false);
            go("change");
          }}
          focusHeading={moved}
        />
      );

    case "change":
      // Next on Step 2 needs the lists, so they are here.
      if (options.status !== "ready") return null;
      return (
        <Change
          items={chosen}
          details={details}
          changes={changes}
          onChange={change}
          onRemove={remove}
          live={options.options}
          gone={goneFor}
          startFailed={startFailed}
          busy={starting}
          onSend={() => void send()}
          focusHeading={moved}
        />
      );

    case "sending": {
      const sent = chosen.filter((i) => states[i.key]?.status === "sent").length;
      return (
        <StepFrame step={3} focusHeading={moved}>
          <p className="text-lg">{copy.sending.keepOpen}</p>
          <p className="text-lg font-medium">{copy.sending.progress(sent, chosen.length)}</p>
          <ul className="flex flex-col gap-4">
            {chosen.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                state={states[item.key] ?? { status: "waiting" }}
                onTryAgain={() => setState(item.key, { status: "waiting" })}
                onRemove={() => remove(item.key)}
              />
            ))}
          </ul>
        </StepFrame>
      );
    }

    case "done":
      return <Done {...counts(chosen)} onMore={startOver} />;
  }
}

/** One Item while sending: its state in words, and its one way forward when it needs one. */
function ItemRow({
  item,
  state,
  onTryAgain,
  onRemove,
}: {
  item: Chosen;
  state: ItemState;
  onTryAgain: () => void;
  onRemove: () => void;
}) {
  const problem = state.status === "failed" || state.status === "refused";
  const label = {
    waiting: copy.sending.waiting,
    sending: copy.sending.sending,
    finishing: item.kind === "video" ? copy.sending.finishingVideo : copy.sending.finishing,
    sent: copy.sending.sent,
    failed: copy.sending.couldNotSave,
    refused:
      state.status === "refused"
        ? copy.sending.cannotAdd(copy.choose.reason(state.refusal, item.kind, item.file.size))
        : "",
  }[state.status];
  return (
    <li className="flex gap-3">
      <Thumb item={item} className="size-16 shrink-0 overflow-hidden rounded" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-sm text-muted-foreground">{item.file.name}</p>
        {/* Only the state is announced, not every percent (#31). */}
        <p role="status" className={`text-base font-medium ${problem ? "text-destructive" : ""}`}>
          {label}
        </p>
        {state.status === "sending" && <ProgressBar value={state.percent} aria-label={item.file.name} />}
        {/* Still moving while ResourceSpace makes a video's previews, so it never looks stuck (#55). */}
        {state.status === "finishing" && <ProgressBar isIndeterminate aria-label={item.file.name} />}
        {state.status === "failed" && (
          <Button variant="primary" className="w-full" onPress={onTryAgain}>
            {copy.sending.tryAgain}
          </Button>
        )}
        {state.status === "refused" && (
          <Button variant="secondary" className="w-full" onPress={onRemove}>
            {copy.sending.remove}
          </Button>
        )}
      </div>
    </li>
  );
}

function Done({ photos, videos, onMore }: { photos: number; videos: number; onMore: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-success/40 bg-success/15 p-6 text-center">
      <p aria-hidden className="text-5xl">
        ✓
      </p>
      <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
        {copy.done.title(photos, videos)}
      </h2>
      <p className="text-lg">{copy.done.next}</p>
      <p className="text-lg">{copy.done.nothingElse}</p>
      <Button variant="secondary" className="w-full" onPress={onMore}>
        {copy.done.more}
      </Button>
    </section>
  );
}

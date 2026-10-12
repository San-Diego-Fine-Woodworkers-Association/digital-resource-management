// The journey: choose photos and videos (many at once, #54), give them a
// Title, tick the rights confirmation, Send, thank-you (#53). The full
// details form (#56), per-Item changes (step 3, #57) and the full set of Item
// states and retries (#58, #59) build on this.
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Description,
  FilePickerButton,
  Input,
  Label,
  Notification,
  ProgressBar,
  TextField,
} from "@sdwa/components";
import type { Refusal } from "../shared/media.ts";
import { choose, type Chosen, type Refused } from "./choose.ts";
import { copy } from "./copy.ts";
import { Gallery, Thumb } from "./Gallery.tsx";
import type { Sender, SendDetails, Submission } from "./send.ts";
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

type Step = "choose" | "describe" | "sending" | "done";

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
  const [title, setTitle] = useState("");
  const [rights, setRights] = useState(false);
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
  };

  const details = (): SendDetails => ({ title: title.trim(), rightsConfirmed: true });

  function start(item: Chosen) {
    const s = submission.current;
    if (!s) return;
    inFlight.current.add(item.key);
    setState(item.key, { status: "sending", percent: 0 });
    s.send(item.file, details(), {
      onProgress: (percent) =>
        setStates((all) => (all[item.key]?.status === "sending" ? { ...all, [item.key]: { status: "sending", percent } } : all)),
      onFinishing: () => setState(item.key, { status: "finishing" }),
    })
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

  function send() {
    if (step !== "describe") return;
    submission.current = sender.begin();
    setStates(Object.fromEntries(chosen.map((i) => [i.key, { status: "waiting" } as ItemState])));
    go("sending");
  }

  const startOver = () => {
    submission.current = undefined;
    setChosen([]);
    setRefused([]);
    setStates({});
    setTitle("");
    setRights(false);
    go("choose");
  };

  // Every Item was taken out while sending: back to the start.
  useEffect(() => {
    if (step === "sending" && chosen.length === 0) startOver();
  }, [step, chosen.length]);

  switch (step) {
    case "choose": {
      const { photos, videos } = counts(chosen);
      return (
        <StepFrame step={0} focusHeading={moved}>
          <p className="text-lg">{copy.choose.intro}</p>
          <FilePickerButton
            variant={chosen.length ? "secondary" : "primary"}
            size="large"
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
              <Button variant="primary" size="large" className="w-full" onPress={() => go("describe")}>
                {copy.choose.next}
              </Button>
            </>
          )}
        </StepFrame>
      );
    }

    case "describe": {
      const needed = [
        ...(title.trim() ? [] : [copy.describe.neededTitle]),
        ...(rights ? [] : [copy.describe.neededRights]),
      ];
      return (
        <StepFrame step={1} focusHeading={moved}>
          {chosen.length > 1 && <p className="text-lg">{copy.describe.appliesToAll(chosen.length)}</p>}
          <p className="text-sm text-muted-foreground">
            <span aria-hidden className="text-destructive">
              *
            </span>{" "}
            {copy.describe.requiredLegend}
          </p>
          <TextField value={title} onChange={setTitle} isRequired className="flex flex-col gap-1">
            <Label className="text-base">{copy.describe.title}</Label>
            <Input className="min-h-12 text-base" maxLength={200} />
            <Description className="text-sm text-muted-foreground">{copy.describe.titleHint}</Description>
          </TextField>
          <Checkbox isSelected={rights} onChange={setRights} isRequired className="min-h-12 gap-3 text-base">
            {copy.describe.rights}
          </Checkbox>
          {needed.length > 0 && <p className="text-base font-medium">{copy.describe.stillNeeded(needed)}</p>}
          <Button variant="primary" size="large" className="w-full" isDisabled={needed.length > 0} onPress={send}>
            {copy.describe.send}
          </Button>
        </StepFrame>
      );
    }

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
    finishing: copy.sending.finishing,
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
        {state.status === "failed" && (
          <Button variant="primary" size="large" className="w-full" onPress={onTryAgain}>
            {copy.sending.tryAgain}
          </Button>
        )}
        {state.status === "refused" && (
          <Button variant="secondary" size="large" className="w-full" onPress={onRemove}>
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
      <Button variant="secondary" size="large" className="w-full" onPress={onMore}>
        {copy.done.more}
      </Button>
    </section>
  );
}

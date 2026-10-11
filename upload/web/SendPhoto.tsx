// The journey for one photo (#53): choose it, give it a Title, tick the
// rights confirmation, Send, thank-you. Many files (#54), the full details
// form (#56), per-Item changes (step 3, #57) and the full set of Item states
// and retries (#58, #59) build on this.
//
// Controls come from @sdwa/components where it has them (Button, TextField,
// Label, Input, Description). The file picker, checkbox and progress bar are
// not in the published design system yet (#38/#39), so they use
// react-aria-components directly, which is what the design system wraps.
import { useEffect, useRef, useState } from "react";
import { Checkbox, FileTrigger, ProgressBar } from "react-aria-components";
import { Description, Input, Label, TextField } from "@sdwa/components";
import { copy } from "./copy.ts";
import type { Sender, SendDetails } from "./send.ts";
import { BigButton, Req, StepFrame } from "./ui.tsx";

/** Photos only in this slice; videos arrive with #55. Matched by content on the service. */
const ACCEPTED = ["image/jpeg", "image/png", "image/heic", "image/heif", ".jpg", ".jpeg", ".png", ".heic", ".heif"];

type Stage =
  | { step: "choose" }
  | { step: "describe" }
  | { step: "sending"; phase: "sending" | "finishing"; percent: number }
  | { step: "failed"; reason: "failed" | "not_a_photo" }
  | { step: "done" };

export function SendPhoto({ sender }: { sender: Sender }) {
  const [stage, setStage] = useState<Stage>({ step: "choose" });
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState("");
  const [rights, setRights] = useState(false);
  // Focus follows the member to each new step, but not on first load.
  const [moved, setMoved] = useState(false);
  const sending = useRef(false);

  const go = (next: Stage) => {
    setMoved(true);
    setStage(next);
  };

  async function send(details: SendDetails) {
    if (!file || sending.current) return;
    sending.current = true;
    go({ step: "sending", phase: "sending", percent: 0 });
    try {
      const result = await sender.send(file, details, {
        onProgress: (percent) => setStage((s) => (s.step === "sending" ? { ...s, percent } : s)),
        onFinishing: () => setStage((s) => (s.step === "sending" ? { ...s, phase: "finishing", percent: 100 } : s)),
      });
      setStage(result.ok ? { step: "done" } : { step: "failed", reason: result.reason });
    } catch {
      setStage({ step: "failed", reason: "failed" });
    } finally {
      sending.current = false;
    }
  }

  const startOver = () => {
    setFile(undefined);
    setTitle("");
    setRights(false);
    go({ step: "choose" });
  };

  const details = (): SendDetails => ({ title: title.trim(), rightsConfirmed: true });

  switch (stage.step) {
    case "choose":
      return (
        <StepFrame step={0} focusHeading={moved}>
          <p className="text-lg">{copy.choose.intro}</p>
          {file && <Chosen file={file} />}
          <FileTrigger
            acceptedFileTypes={ACCEPTED}
            onSelect={(list) => {
              const picked = list?.[0];
              if (picked) setFile(picked);
            }}
          >
            <BigButton variant={file ? "secondary" : "primary"}>{copy.choose.button}</BigButton>
          </FileTrigger>
          {file && (
            <BigButton variant="primary" onPress={() => go({ step: "describe" })}>
              {copy.choose.next}
            </BigButton>
          )}
        </StepFrame>
      );

    case "describe": {
      const needed = [
        ...(title.trim() ? [] : [copy.describe.neededTitle]),
        ...(rights ? [] : [copy.describe.neededRights]),
      ];
      return (
        <StepFrame step={1} focusHeading={moved}>
          <p className="text-sm text-muted-foreground">
            <span aria-hidden className="text-destructive">
              *
            </span>{" "}
            {copy.describe.requiredLegend}
          </p>
          <TextField value={title} onChange={setTitle} isRequired className="flex flex-col gap-1">
            <Label className="text-base font-medium">
              {copy.describe.title}
              <Req />
            </Label>
            <Input className="min-h-12 text-base" maxLength={200} />
            <Description className="text-sm text-muted-foreground">{copy.describe.titleHint}</Description>
          </TextField>
          <Checkbox isSelected={rights} onChange={setRights} className="group flex min-h-12 items-start gap-3 text-base">
            <span
              aria-hidden
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded border-2 border-foreground bg-background text-lg group-data-[selected]:border-primary group-data-[selected]:bg-primary group-data-[selected]:text-primary-foreground group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring"
            >
              {rights ? "✓" : ""}
            </span>
            <span>
              {copy.describe.rights}
              <Req />
            </span>
          </Checkbox>
          {needed.length > 0 && <p className="text-base font-medium">{copy.describe.stillNeeded(needed)}</p>}
          <BigButton variant="primary" isDisabled={needed.length > 0} onPress={() => void send(details())}>
            {copy.describe.send}
          </BigButton>
        </StepFrame>
      );
    }

    case "sending":
    case "failed":
      return (
        <StepFrame step={3} focusHeading={moved}>
          <p className="text-lg">{copy.sending.keepOpen}</p>
          {file && <Chosen file={file} compact />}
          <Progress stage={stage} />
          {stage.step === "failed" && stage.reason === "failed" && (
            <BigButton variant="primary" onPress={() => void send(details())}>
              {copy.sending.tryAgain}
            </BigButton>
          )}
          {stage.step === "failed" && stage.reason === "not_a_photo" && (
            <BigButton variant="secondary" onPress={startOver}>
              {copy.sending.remove}
            </BigButton>
          )}
        </StepFrame>
      );

    case "done":
      return <Done onMore={startOver} />;
  }
}

/** The state of the photo. Only the state is announced, not every percent (#31). */
function Progress({ stage }: { stage: Extract<Stage, { step: "sending" | "failed" }> }) {
  const sending = stage.step === "sending";
  const label =
    stage.step === "failed"
      ? stage.reason === "not_a_photo"
        ? `${copy.sending.cannotAdd} ${copy.sending.wrongType}`
        : copy.sending.couldNotSave
      : stage.phase === "finishing"
        ? copy.sending.finishing
        : copy.sending.sending;
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className={`text-base font-medium ${sending ? "" : "text-destructive"}`}>
        {label}
      </p>
      {sending && (
        <ProgressBar value={stage.percent} aria-label={copy.sending.sending} className="flex flex-col gap-1">
          {({ percentage }) => (
            <>
              <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary" style={{ width: `${percentage}%` }} />
              </div>
              {stage.phase === "sending" && (
                <span aria-hidden className="text-sm text-muted-foreground">
                  {copy.sending.sending} {Math.round(percentage ?? 0)}%
                </span>
              )}
            </>
          )}
        </ProgressBar>
      )}
    </div>
  );
}

function Chosen({ file, compact = false }: { file: File; compact?: boolean }) {
  const [url, setUrl] = useState<string>();
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    // jsdom and very old browsers have no object URLs: show the placeholder.
    if (typeof URL.createObjectURL !== "function") return setBroken(true);
    const u = URL.createObjectURL(file);
    setUrl(u);
    setBroken(false);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const size = compact ? "h-24 w-24" : "h-48 w-48";
  return (
    <div className="flex flex-col gap-2">
      {broken || !url ? (
        <div
          className={`flex ${size} items-center justify-center rounded bg-secondary p-2 text-center text-sm text-muted-foreground`}
        >
          {copy.choose.noPreview}
        </div>
      ) : (
        <img src={url} alt={file.name} onError={() => setBroken(true)} className={`${size} rounded bg-secondary object-cover`} />
      )}
      {!compact && <p className="text-base font-medium">{copy.choose.chosen(1)}</p>}
    </div>
  );
}

function Done({ onMore }: { onMore: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-success/40 bg-success/15 p-6 text-center">
      <p aria-hidden className="text-5xl">
        ✓
      </p>
      <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
        {copy.done.title(1)}
      </h2>
      <p className="text-lg">{copy.done.next}</p>
      <p className="text-lg">{copy.done.nothingElse}</p>
      <BigButton variant="secondary" onPress={onMore}>
        {copy.done.more}
      </BigButton>
    </section>
  );
}

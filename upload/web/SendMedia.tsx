// The journey: choose photos and videos (many at once, #54), describe them
// all once (#56), change any single one (optional, #57), Send, thank-you
// (#53). Each Item's state and its automatic tries are itemState.ts (#58); at
// the end, the thank-you, or "Most of your photos are in" when any was not
// sent.
//
// Interruptions (#59): while sending, the screen is kept awake and leaving
// the page asks first (also on Steps 1 to 3 once anything is chosen, and on
// "Most of your photos are in"). Offline, or signed out, or no longer a member, the
// page holds: nothing new starts and no automatic try runs, and it carries
// on when the connection is back or the member has signed in again (in a
// new tab, so the chosen photos stay here). A busy service holds the rest of
// the queue while its Item tries again on the Connection trouble schedule.
// Steps 1 to 3 are browser history entries (stepHistory.ts).
import { useEffect, useRef, useState } from "react";
import { Button, FilePickerButton, Link, Notification, NotificationRegion, ProgressBar } from "@sdwa/components";
import { SIGNED_IN_PATH, type ShellUser } from "../shared/boot.ts";
import { changedFields, NO_DETAILS, withChanges, type Changes, type DetailField, type Details } from "../shared/details.ts";
import { Change } from "./Change.tsx";
import { choose, type Chosen, type Refused } from "./choose.ts";
import { copy } from "./copy.ts";
import { Describe, type OptionsState } from "./Describe.tsx";
import { Gallery, Thumb } from "./Gallery.tsx";
import { browserOffline, useLeaveWarning, usePageEvents, useWakeLock } from "./interruptions.ts";
import {
  canStart,
  canTryAgain,
  isBusyTrouble,
  isSettled,
  nextState,
  retryDelay,
  WAITING,
  type ItemEvent,
  type ItemState,
} from "./itemState.ts";
import type { Sender, SignInTrouble, Submission } from "./send.ts";
import { useStepHistory } from "./stepHistory.ts";
import { Problem, StepFrame } from "./ui.tsx";

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

/** "someNotSent": the end, with at least one sent and at least one not. */
type Step = "choose" | "describe" | "change" | "sending" | "someNotSent" | "done";

/** Each step's browser history entry: Steps 1 to 3 have their own; from Send on, the first one's. */
const HISTORY_INDEX: Record<Step, number> = { choose: 0, describe: 1, change: 2, sending: 0, someNotSent: 0, done: 0 };

/** Who is signed in, and where to go if their membership lapses mid-send (#59). */
export interface Account {
  user: ShellUser;
  renewUrl: string;
  switchAccountUrl: string;
}

function counts(items: Chosen[]) {
  const videos = items.filter((i) => i.kind === "video").length;
  return { photos: items.length - videos, videos };
}

export function SendMedia({ sender, account }: { sender: Sender; account?: Account }) {
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
  // The pause before each Item's next automatic try, by key.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Interruptions (#59): no connection, and the member signed out or no
  // longer a member. Either holds the page.
  const [offline, setOffline] = useState(browserOffline);
  const [signIn, setSignIn] = useState<SignInTrouble | null>(null);
  const held = offline || signIn !== null;
  // Send is pressed only once, even twice in a row before the page redraws.
  const sendPressed = useRef(false);
  const checkingSession = useRef(false);
  const stepNow = useRef(step);
  stepNow.current = step;

  const show = (next: Step) => {
    setMoved(true);
    setStep(next);
  };
  const moveHistoryTo = useStepHistory((index) => {
    // The member pressed Back: to Step 2 from Step 3 keeps every change, as the page's own Back does.
    if (index === 1 && stepNow.current === "change") backToDescribe();
    else if (index === 0) show("choose");
    else show("describe");
  });
  const go = (next: Step) => {
    moveHistoryTo(HISTORY_INDEX[next]);
    show(next);
  };

  /** Moves one Item on; one taken out stays out. */
  const dispatch = (key: string, event: ItemEvent) =>
    setStates((all) => {
      const state = all[key];
      if (!state) return all;
      const next = nextState(state, event);
      return next === state ? all : { ...all, [key]: next };
    });

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

  // Back from Step 3 to Step 2 keeps everything: the Step 2 answers, the
  // rights tick and each one's changes. Each one keeps only the fields it
  // actually changes (an override); every other field follows Step 2, so a
  // Step 2 answer edited after Back reaches every one that didn't change it.
  // A box the member typed back to the Step 2 answer is dropped here, so it
  // isn't pinned to the old answer without a Changed badge saying so.
  const backToDescribe = () => {
    setChanges((c) => {
      const kept: Record<string, Changes> = {};
      for (const [key, itemChanges] of Object.entries(c)) {
        const fields = changedFields(details, itemChanges);
        if (fields.length > 0) kept[key] = Object.fromEntries(fields.map((f) => [f, itemChanges[f]]));
      }
      return kept;
    });
    setStartFailed(false);
    show("describe");
  };
  const back = () => {
    moveHistoryTo(HISTORY_INDEX.describe);
    backToDescribe();
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
    dispatch(item.key, { type: "start" });
    s.send(
      item.file,
      {
        onProgress: (percent) => dispatch(item.key, { type: "progress", percent }),
        onFinishing: () => dispatch(item.key, { type: "finishing" }),
      },
      item.key,
    )
      .catch(() => ({ ok: false as const, reason: "failed" as const }))
      .then((result) => {
        inFlight.current.delete(item.key);
        // The member is not signed in any more: hold everything until they are (#59).
        if (!result.ok && (result.reason === "signed_out" || result.reason === "not_member")) setSignIn(result.reason);
        dispatch(item.key, { type: "result", result });
      });
  }

  // Two at a time: whenever one finishes, the next one that may start does,
  // whether its turn has come or its next automatic try. Nothing starts while
  // the page is held; while the service is busy, only the busy one's own
  // tries go, so the rest of the queue waits with it (#59).
  const busy = chosen.some((i) => isBusyTrouble(states[i.key] ?? WAITING));
  useEffect(() => {
    if (step !== "sending") return;
    // The browser may know before any event says so (Send pressed with no connection).
    if (!held && browserOffline()) {
      setOffline(true);
      return;
    }
    for (const item of held ? [] : chosen) {
      if (inFlight.current.size >= AT_ONCE) break;
      const state = states[item.key] ?? WAITING;
      if (busy && state.status === "waiting") continue;
      if (canStart(state) && !inFlight.current.has(item.key)) start(item);
    }
    // Nothing more is happening: the end. One that can't be added is listed there with its reason.
    const all = chosen.map((i) => states[i.key] ?? WAITING);
    if (all.length === 0 || !all.every(isSettled)) return;
    const sent = all.filter((s) => s.status === "sent").length;
    // The Reviewers' email goes now (#61), partial if some are not in. One the
    // member removed while sending is no longer expected; one that can't be
    // added, still here, is (they wanted to send it).
    if (sent > 0) submission.current?.finished?.(all.length);
    if (sent === all.length) go("done");
    // With none sent, "most are in" would not be true: each stays with its Try again.
    else if (sent > 0) go("someNotSent");
  }, [step, chosen, states, held, busy]);

  // The pause before each automatic try (itemState.ts has the schedule).
  // None while the page is held: it resumes them all at once when it can.
  useEffect(() => {
    for (const [key, timer] of timers.current) {
      if (held || retryDelay(states[key] ?? WAITING) === undefined) {
        clearTimeout(timer);
        timers.current.delete(key);
      }
    }
    for (const [key, state] of Object.entries(states)) {
      const delay = retryDelay(state);
      if (held || delay === undefined || timers.current.has(key)) continue;
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          dispatch(key, { type: "retryDue" });
        }, delay),
      );
    }
  }, [states, held]);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all.values()) clearTimeout(timer);
      all.clear();
    };
  }, []);

  /** Every automatic try is due now: back online, in the foreground, or signed in again. Only while sending. */
  const resumeAll = () => {
    if (stepNow.current !== "sending") return;
    setStates((all) => {
      let changed = false;
      const next: Record<string, ItemState> = {};
      for (const [key, state] of Object.entries(all)) {
        next[key] = nextState(state, { type: "resume" });
        changed ||= next[key] !== state;
      }
      return changed ? next : all;
    });
  };

  /** Asks the service again whether the member is signed in, when they come back to this tab. */
  const checkSession = () => {
    if (signIn === null || checkingSession.current) return;
    checkingSession.current = true;
    sender
      .session()
      .catch(() => "unknown" as const)
      .then((result) => {
        checkingSession.current = false;
        if (result === "signed_in") {
          setSignIn(null);
          resumeAll();
        } else if (result !== "unknown") setSignIn(result);
      });
  };

  usePageEvents({
    onOffline: () => setOffline(true),
    onOnline: () => {
      setOffline(false);
      resumeAll();
    },
    onForeground: () => {
      // Phones freeze a page in the background; the browser may also have missed going offline or online.
      setOffline(browserOffline());
      if (signIn !== null) checkSession();
      else if (!browserOffline()) resumeAll();
    },
    onFocus: checkSession,
  });

  // Something is still on its way: keep the screen awake and ask before leaving.
  const going = step === "sending" && chosen.some((i) => !isSettled(states[i.key] ?? WAITING));
  useWakeLock(going);
  // On Steps 1 to 3, anything chosen would be lost too, and on "Most of your
  // photos are in" any not sent. Moving between the steps (stepHistory.ts)
  // stays on the page, so it never asks then. The dialog's words are the
  // browser's own.
  const choosing = (step === "choose" || step === "describe" || step === "change") && chosen.length > 0;
  const notAllIn = step === "someNotSent" && chosen.some((i) => states[i.key]?.status !== "sent");
  useLeaveWarning(going || choosing || notAllIn);

  /** Try again for every one that was not sent and can be (the end screen). */
  const tryTheRestAgain = () => {
    for (const item of chosen) if (canTryAgain(states[item.key] ?? WAITING)) dispatch(item.key, { type: "tryAgain" });
    go("sending");
  };

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
    if (step !== "change" || starting || sendPressed.current) return;
    sendPressed.current = true;
    setStarting(true);
    setStartFailed(false);
    const items = itemChanges();
    const result = await sender
      .begin({ expectedItems: chosen.length, details, ...(Object.keys(items).length ? { items } : {}), rightsConfirmed: true })
      .catch(() => ({ ok: false as const, reason: "failed" as const }));
    sendPressed.current = false;
    setStarting(false);
    if (!result.ok && (result.reason === "signed_out" || result.reason === "not_member")) {
      // Send again once signed in; nothing was sent.
      setSignIn(result.reason);
      return;
    }
    if (result.ok) {
      submission.current = result.submission;
      setStates(Object.fromEntries(chosen.map((i) => [i.key, WAITING])));
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

  // What holds the page, said once above the step (#59): signed out or no
  // longer a member first (only the member can fix it), then no connection,
  // then a busy service, while sending. The region is always on the page, so
  // a notice that appears in it is announced (#62).
  const notice =
    signIn !== null ? (
      <SignInNotice trouble={signIn} account={account} />
    ) : step === "sending" && offline ? (
      <Notification variant="warning">{copy.problems.offline}</Notification>
    ) : step === "sending" && busy ? (
      <Notification variant="info">{copy.problems.busy}</Notification>
    ) : null;

  return (
    <>
      <NotificationRegion>{notice}</NotificationRegion>
      {screenFor()}
    </>
  );

  function screenFor() {
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
                {/* A camera's file name has no spaces: let it break anywhere rather than run off the screen (#62). */}
                <ul className="flex list-disc flex-col gap-1 pl-5 text-base text-foreground [overflow-wrap:anywhere]">
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
            onBack={back}
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
                  state={states[item.key] ?? WAITING}
                  onTryAgain={() => dispatch(item.key, { type: "tryAgain" })}
                  onRemove={() => remove(item.key)}
                />
              ))}
            </ul>
          </StepFrame>
        );
      }

      case "someNotSent":
        return (
          <SomeNotSent
            items={chosen.filter((i) => states[i.key]?.status !== "sent")}
            states={states}
            total={chosen.length}
            onTryAgain={tryTheRestAgain}
            onLater={() => go("done")}
          />
        );

      case "done": {
        // Only what was sent: after "I'll do the rest later", not everything was.
        const sent = chosen.filter((i) => states[i.key]?.status === "sent");
        return <Done {...counts(sent)} allSent={sent.length === chosen.length} onMore={startOver} />;
      }
    }
  }
}

/**
 * Signed out, or no longer a member, part way through (#30, #31). Signing in
 * again opens in a new tab, so the chosen photos stay in this one; the page
 * carries on when the member comes back to it.
 */
function SignInNotice({ trouble, account }: { trouble: SignInTrouble; account?: Account }) {
  if (trouble === "signed_out") {
    return (
      <Notification
        variant="warning"
        actions={
          <Link variant="primary" className="w-full" href={SIGNED_IN_PATH} target="_blank" rel="noopener">
            {copy.problems.signInAgain}
          </Link>
        }
      >
        {copy.problems.signedOut}
      </Notification>
    );
  }
  return (
    <Notification variant="warning" title={copy.notMember.title}>
      <div className="flex flex-col gap-3">
        {account && <p>{copy.notMember.signedInAs(account.user.name)}</p>}
        <p>{copy.notMember.explain}</p>
        <p>{copy.problems.notMemberStillHere}</p>
        {account && (
          <>
            <Link variant="primary" className="w-full" href={account.renewUrl} target="_blank" rel="noopener">
              {copy.notMember.renew}
            </Link>
            <Link variant="secondary" className="w-full" href={account.switchAccountUrl} target="_blank" rel="noopener">
              {copy.notMember.switchAccount}
            </Link>
          </>
        )}
      </div>
    </Notification>
  );
}

/** What one Item's state says. */
function labelOf(item: Chosen, state: ItemState): string {
  switch (state.status) {
    case "waiting":
      return copy.sending.waiting;
    case "sending":
      return copy.sending.sending;
    case "finishing":
      return item.kind === "video" ? copy.sending.finishingVideo : copy.sending.finishing;
    case "sent":
      return copy.sending.sent;
    case "connection":
      // A busy service is said once for the page (#59); each one waits its turn again.
      return state.busy ? copy.sending.waiting : copy.sending.connection;
    case "stalled":
      return copy.sending.waitingForConnection;
    case "failed":
      return copy.sending.couldNotSave;
    case "busy":
      return copy.sending.busy;
    case "refused":
      return copy.sending.cannotAdd(copy.choose.reason(state.refusal, item.kind, item.file.size));
  }
}

/** A state the member needs to see as a problem (in words first; the colour only adds to them). */
const isProblem = (state: ItemState) => ["failed", "refused", "stalled"].includes(state.status);

/**
 * A line that says something went wrong, so it carries the ⚠ (#31, #62):
 * those above, a busy service once the page stops trying, and Connection
 * trouble (but not while busy: then the line is Waiting, and the page's
 * notice says why).
 */
const hasProblemIcon = (state: ItemState) =>
  isProblem(state) || state.status === "busy" || (state.status === "connection" && !state.busy);

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
  const problem = isProblem(state);
  const label = labelOf(item, state);
  return (
    <li className="flex gap-3">
      <Thumb item={item} className="size-16 shrink-0 overflow-hidden rounded" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-sm text-muted-foreground">{item.file.name}</p>
        {/* Only the state is announced, not every percent (#31). */}
        <p role="status" className={`text-base font-medium ${problem ? "text-destructive" : ""}`}>
          {hasProblemIcon(state) ? <Problem>{label}</Problem> : label}
        </p>
        {state.status === "sending" && <ProgressBar value={state.percent} aria-label={item.file.name} />}
        {/* Still moving while ResourceSpace makes a video's previews, so it never looks stuck (#55). */}
        {state.status === "finishing" && <ProgressBar isIndeterminate aria-label={item.file.name} />}
        {canTryAgain(state) && (
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

/**
 * The end when some were not sent (#30, #31): which ones, Try again for all
 * of them, and a way out that keeps what was sent.
 */
function SomeNotSent({
  items,
  states,
  total,
  onTryAgain,
  onLater,
}: {
  items: Chosen[];
  states: Record<string, ItemState>;
  total: number;
  onTryAgain: () => void;
  onLater: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-warning/60 bg-warning/15 p-6">
      <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
        {copy.someNotSent.title}
      </h2>
      <p className="text-lg">{copy.someNotSent.notSent(items.length, total)}</p>
      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const state = states[item.key] ?? WAITING;
          return (
            // With big text, the words go under the picture rather than off the screen (#62).
            <li key={item.key} className="flex flex-wrap items-center gap-3">
              <Thumb item={item} className="size-16 shrink-0 overflow-hidden rounded" />
              <div className="flex min-w-[8rem] flex-1 flex-col gap-1">
                <p className="truncate text-base">{item.file.name}</p>
                {/* Not red here: on this screen's tint it is too faint (#62), and every one listed is a problem. */}
                <p className="text-base font-medium">
                  <Problem>{labelOf(item, state)}</Problem>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {/* Not for one that can't be added: trying again won't change that. */}
      {items.some((i) => canTryAgain(states[i.key] ?? WAITING)) && (
        <Button variant="primary" className="w-full" onPress={onTryAgain}>
          {copy.someNotSent.tryAgain}
        </Button>
      )}
      <Button variant="secondary" className="w-full" onPress={onLater}>
        {copy.someNotSent.later}
      </Button>
    </section>
  );
}

function Done({
  photos,
  videos,
  allSent,
  onMore,
}: {
  photos: number;
  videos: number;
  /** False after "I'll do the rest later": it says the rest weren't sent. */
  allSent: boolean;
  onMore: () => void;
}) {
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
      <p className="text-lg">{allSent ? copy.done.nothingElse : copy.done.notAllSent}</p>
      <Button variant="secondary" className="w-full" onPress={onMore}>
        {copy.done.more}
      </Button>
    </section>
  );
}

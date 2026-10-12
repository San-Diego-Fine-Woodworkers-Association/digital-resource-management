// Step 2, "Tell us about them" (#56): the details given once for everything
// chosen. Title, the occasion (Program / Event) and what's in them (Subject
// Type) are required, marked with the red `*` the legend explains, and a
// plain Still-needed line names whatever is missing while the button stays
// disabled. The rest is optional. The occasion, subject and place choices are
// the club's own lists, fetched live from ResourceSpace by the page; the
// service checks the answers again when the member presses Send.
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Description,
  Input,
  Label,
  Notification,
  Select,
  SelectItem,
  TextArea,
  TextField,
} from "@sdwa/components";
import { MAX_LENGTH, stillNeeded, type DetailField, type Details, type Options } from "../shared/details.ts";
import { copy } from "./copy.ts";
import { StepFrame } from "./ui.tsx";

export type OptionsState = { status: "loading" } | { status: "ready"; options: Options } | { status: "failed" };

/** The Still-needed line's name for each required answer. */
const NEEDED: Partial<Record<DetailField, string>> = {
  title: copy.describe.neededTitle,
  programevent: copy.describe.neededOccasion,
  subjecttype: copy.describe.neededSubjects,
};

/** The Select item that empties the optional place again (never sent; only its key). */
const NONE = "--leave-empty--";

// Touch targets of at least 48 px and 18 px text (#31). The design system's
// Select and CheckboxGroup take a class only on their outer element, so their
// label and trigger are reached from there.
const LABEL = "text-base";
const SELECT = "[&>:first-child]:text-base [&_button]:min-h-12 [&_button]:text-base [&_[slot=errorMessage]]:text-sm";
const ITEM = "min-h-12 text-base";
const BOX = "min-h-12 gap-3 text-base";

export function Describe({
  count,
  details,
  onChange,
  rights,
  onRights,
  options,
  onRetryOptions,
  gone,
  startFailed,
  busy,
  onSend,
  focusHeading,
}: {
  /** How many photos and videos these details are for. */
  count: number;
  details: Details;
  onChange: (details: Details) => void;
  rights: boolean;
  onRights: (rights: boolean) => void;
  options: OptionsState;
  onRetryOptions: () => void;
  /** Fields whose choice the club's list no longer has (the service said so on Send). */
  gone: DetailField[];
  startFailed: boolean;
  busy: boolean;
  onSend: () => void;
  focusHeading: boolean;
}) {
  const set = (change: Partial<Details>) => onChange({ ...details, ...change });
  const needed = [...stillNeeded(details).map((f) => NEEDED[f]!), ...(rights ? [] : [copy.describe.neededRights])];
  const live = options.status === "ready" ? options.options : undefined;

  return (
    <StepFrame step={1} focusHeading={focusHeading}>
      {count > 1 && <p className="text-lg">{copy.describe.appliesToAll(count)}</p>}
      <p className="text-sm text-muted-foreground">
        <span aria-hidden className="text-destructive">
          *
        </span>{" "}
        {copy.describe.requiredLegend}
      </p>

      <TextField value={details.title} onChange={(title) => set({ title })} isRequired className="flex flex-col gap-1">
        <Label className={LABEL}>{copy.describe.title}</Label>
        <Input className="min-h-12 text-base" maxLength={MAX_LENGTH.title} />
        <Description className="text-sm text-muted-foreground">{copy.describe.titleHint}</Description>
      </TextField>

      {options.status === "loading" && (
        <p role="status" className="text-base text-muted-foreground">
          {copy.describe.loadingChoices}
        </p>
      )}
      {options.status === "failed" && (
        <Notification
          variant="warning"
          title={copy.describe.choicesFailed}
          actions={
            <Button variant="secondary" size="large" className="w-full" onPress={onRetryOptions}>
              {copy.describe.tryAgain}
            </Button>
          }
        />
      )}
      {live && (
        <>
          <Select
            label={copy.describe.occasion}
            placeholder={copy.describe.chooseOne}
            isRequired
            value={details.programevent || null}
            onChange={(key) => set({ programevent: key == null ? "" : String(key) })}
            isInvalid={gone.includes("programevent")}
            errorMessage={copy.describe.noLongerOffered}
            className={SELECT}
          >
            {live.programevent.map((name) => (
              <SelectItem key={name} id={name} className={ITEM}>
                {name}
              </SelectItem>
            ))}
          </Select>
          <CheckboxGroup
            label={copy.describe.subjects}
            isRequired
            value={details.subjecttype}
            onChange={(subjecttype) => set({ subjecttype })}
            isInvalid={gone.includes("subjecttype")}
            errorMessage={copy.describe.noLongerOffered}
            className="[&>:first-child]:text-base [&_[slot=errorMessage]]:text-sm"
          >
            {live.subjecttype.map((name) => (
              <Checkbox key={name} value={name} className={BOX}>
                {name}
              </Checkbox>
            ))}
          </CheckboxGroup>
        </>
      )}

      <TextField value={details.date} onChange={(date) => set({ date })} className="flex flex-col gap-1">
        <Label className={LABEL}>{copy.describe.date}</Label>
        {/* The phone's own date picker; it gives YYYY-MM-DD, or nothing. */}
        <Input type="date" className="min-h-12 text-base" />
        <Description className="text-sm text-muted-foreground">{copy.describe.dateHint}</Description>
      </TextField>

      {live && (
        <Select
          label={copy.describe.location}
          placeholder={copy.describe.chooseOne}
          value={details.location || null}
          onChange={(key) => set({ location: key == null || key === NONE ? "" : String(key) })}
          isInvalid={gone.includes("location")}
          errorMessage={copy.describe.noLongerOffered}
          className={SELECT}
        >
          {[
            ...(details.location
              ? [
                  <SelectItem key={NONE} id={NONE} className={ITEM}>
                    {copy.describe.leaveEmpty}
                  </SelectItem>,
                ]
              : []),
            ...live.location.map((name) => (
              <SelectItem key={name} id={name} className={ITEM}>
                {name}
              </SelectItem>
            )),
          ]}
        </Select>
      )}

      <TextField value={details.eventname} onChange={(eventname) => set({ eventname })} className="flex flex-col gap-1">
        <Label className={LABEL}>{copy.describe.eventName}</Label>
        <Input className="min-h-12 text-base" maxLength={MAX_LENGTH.eventname} />
      </TextField>

      <TextField value={details.caption} onChange={(caption) => set({ caption })} className="flex flex-col gap-1">
        <Label className={LABEL}>{copy.describe.caption}</Label>
        <TextArea className="min-h-32 text-base" maxLength={MAX_LENGTH.caption} />
      </TextField>

      <Checkbox isSelected={rights} onChange={onRights} isRequired className={BOX}>
        {copy.describe.rights}
      </Checkbox>

      {gone.length > 0 && (
        <p role="alert" className="text-base font-medium text-destructive">
          {copy.describe.choiceGone}
        </p>
      )}
      {startFailed && (
        <p role="alert" className="text-base font-medium text-destructive">
          {copy.describe.startFailed}
        </p>
      )}
      {needed.length > 0 && <p className="text-base font-medium">{copy.describe.stillNeeded(needed)}</p>}
      <Button
        variant="primary"
        size="large"
        className="w-full"
        isDisabled={needed.length > 0 || !live || busy}
        onPress={onSend}
      >
        {copy.describe.send}
      </Button>
    </StepFrame>
  );
}

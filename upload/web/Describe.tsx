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
        <Label>{copy.describe.title}</Label>
        <Input maxLength={MAX_LENGTH.title} />
        <Description>{copy.describe.titleHint}</Description>
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
            <Button variant="secondary" className="w-full" onPress={onRetryOptions}>
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
           
          >
            {live.programevent.map((name) => (
              <SelectItem key={name} id={name}>
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
          >
            {live.subjecttype.map((name) => (
              <Checkbox key={name} value={name}>
                {name}
              </Checkbox>
            ))}
          </CheckboxGroup>
        </>
      )}

      <TextField value={details.date} onChange={(date) => set({ date })} className="flex flex-col gap-1">
        <Label>{copy.describe.date}</Label>
        {/* The phone's own date picker; it gives YYYY-MM-DD, or nothing. */}
        <Input type="date" />
        <Description>{copy.describe.dateHint}</Description>
      </TextField>

      {live && (
        <Select
          label={copy.describe.location}
          placeholder={copy.describe.chooseOne}
          value={details.location || null}
          onChange={(key) => set({ location: key == null || key === NONE ? "" : String(key) })}
          isInvalid={gone.includes("location")}
          errorMessage={copy.describe.noLongerOffered}
         
        >
          {[
            ...(details.location
              ? [
                  <SelectItem key={NONE} id={NONE}>
                    {copy.describe.leaveEmpty}
                  </SelectItem>,
                ]
              : []),
            ...live.location.map((name) => (
              <SelectItem key={name} id={name}>
                {name}
              </SelectItem>
            )),
          ]}
        </Select>
      )}

      <TextField value={details.eventname} onChange={(eventname) => set({ eventname })} className="flex flex-col gap-1">
        <Label>{copy.describe.eventName}</Label>
        <Input maxLength={MAX_LENGTH.eventname} />
      </TextField>

      <TextField value={details.caption} onChange={(caption) => set({ caption })} className="flex flex-col gap-1">
        <Label>{copy.describe.caption}</Label>
        <TextArea maxLength={MAX_LENGTH.caption} />
      </TextField>

      <Checkbox isSelected={rights} onChange={onRights} isRequired>
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
       
        className="w-full"
        isDisabled={needed.length > 0 || !live || busy}
        onPress={onSend}
      >
        {copy.describe.send}
      </Button>
    </StepFrame>
  );
}

// Step 3, "Change any single one (optional)" (#57, the prototype's Variant
// B): the same gallery as Step 1. Tapping a photo or video opens a dialog
// with the Step 2 questions, prefilled with the Step 2 answers. Whatever the
// member changes there is kept for that one at once (Done, Escape or tapping
// outside all keep it); an emptied box means "use the Step 2 answer", so a
// single one can never blank a field Step 2 filled in. A changed one shows a
// Changed badge, which goes again when its answers match Step 2's. The
// rights confirmation is not asked here: it is given once for everything.
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "@sdwa/components";
import { changedFields, DETAIL_FIELDS, type Changes, type DetailField, type Details, type Options } from "../shared/details.ts";
import type { Chosen } from "./choose.ts";
import { copy } from "./copy.ts";
import { DetailFields } from "./Describe.tsx";
import { Gallery, Thumb } from "./Gallery.tsx";
import { StepFrame } from "./ui.tsx";

/** What the dialog's boxes show: what the member has typed for this one, or else the Step 2 answer. */
function shown(details: Details, changes: Changes = {}): Details {
  return Object.fromEntries(DETAIL_FIELDS.map((f) => [f, changes[f] ?? details[f]])) as unknown as Details;
}

/** The changes without the emptied boxes, so the dialog opens next time showing the Step 2 answers there. */
function withoutEmpty(changes: Changes = {}): Changes {
  return Object.fromEntries(
    Object.entries(changes).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "")),
  );
}

export function isChanged(details: Details, changes: Changes | undefined): boolean {
  return changedFields(details, changes).length > 0;
}

export function Change({
  items,
  details,
  changes,
  onChange,
  onRemove,
  live,
  gone,
  startFailed,
  busy,
  onSend,
  focusHeading,
}: {
  items: Chosen[];
  /** The Step 2 answers. */
  details: Details;
  /** What each one changed, by its key. */
  changes: Record<string, Changes>;
  onChange: (key: string, changes: Changes) => void;
  onRemove: (key: string) => void;
  live: Options;
  /** By key: choices the club's list no longer has (the service said so on Send). */
  gone: Record<string, DetailField[]>;
  startFailed: boolean;
  busy: boolean;
  onSend: () => void;
  focusHeading: boolean;
}) {
  const [open, setOpen] = useState<Chosen>();
  const list = useRef<HTMLDivElement>(null);
  // After Remove this one, focus goes to the next tile (or the previous one),
  // not to the top of the page. After a frame, so it lands after the dialog
  // has handed focus back.
  const [focusAfterRemove, setFocusAfterRemove] = useState<string>();
  useEffect(() => {
    if (!focusAfterRemove) return;
    const frame = requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`li[data-key="${focusAfterRemove}"] > button`)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusAfterRemove, items]);

  const close = () => {
    if (open) onChange(open.key, withoutEmpty(changes[open.key]));
    setOpen(undefined);
  };

  const remove = () => {
    if (!open) return;
    const index = items.findIndex((i) => i.key === open.key);
    setFocusAfterRemove((items[index + 1] ?? items[index - 1])?.key);
    setOpen(undefined);
    onRemove(open.key);
  };

  const goneNames = items.filter((i) => gone[i.key]?.length).map((i) => i.file.name);

  return (
    <StepFrame step={2} focusHeading={focusHeading}>
      <p className="text-lg">
        {copy.change.intro} <strong>{copy.change.optional}</strong> {copy.change.howTo}
      </p>
      <div ref={list}>
        <Gallery
          items={items}
          onOpen={(item) => {
            setFocusAfterRemove(undefined);
            setOpen(item);
          }}
          tileLabel={(item) => copy.change.open(item.file.name, isChanged(details, changes[item.key]))}
          changed={(key) => isChanged(details, changes[key])}
        />
      </div>

      {goneNames.length > 0 && (
        <p role="alert" className="text-base font-medium text-destructive">
          {copy.change.choiceGone(goneNames)}
        </p>
      )}
      {startFailed && (
        <p role="alert" className="text-base font-medium text-destructive">
          {copy.describe.startFailed}
        </p>
      )}
      <Button variant="primary" className="w-full" isDisabled={busy} onPress={onSend}>
        {copy.change.send}
      </Button>

      <ModalOverlay
        isDismissable
        isOpen={open !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) close();
        }}
      >
        <Modal className="p-4">
          <Dialog
            aria-labelledby="change-one-title"
            aria-describedby="change-one-note"
            className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto outline-none"
          >
            {open && (
              <>
                <div className="flex items-center gap-3">
                  <Thumb item={open} className="size-20 shrink-0 overflow-hidden rounded" />
                  <h3 id="change-one-title" className="min-w-0 break-words text-xl font-bold">
                    {copy.change.dialogTitle(open.file.name)}
                  </h3>
                </div>
                <p id="change-one-note" className="text-base text-muted-foreground">
                  {copy.change.leaveEmpty}
                </p>
                <DetailFields
                  values={shown(details, changes[open.key])}
                  onChange={(change) => onChange(open.key, { ...changes[open.key], ...change })}
                  live={live}
                  forAll={false}
                  // Only a place Step 2 left empty can be emptied again here.
                  canEmptyPlace={details.location === ""}
                  gone={gone[open.key] ?? []}
                />
                <Button variant="primary" className="w-full" onPress={close}>
                  {copy.change.done}
                </Button>
                <Button variant="secondary" className="w-full" onPress={remove}>
                  {copy.change.remove}
                </Button>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </StepFrame>
  );
}

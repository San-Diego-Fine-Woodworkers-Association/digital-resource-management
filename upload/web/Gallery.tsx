// The chosen photos and videos (#54, the prototype's Variant B): every one is
// shown, in a 3-column grid that scrolls after 4 rows. In Step 1 each tile
// opens the photo or video full size, and has its own ✕ to take it out. In
// Step 3 (#57) the same gallery opens each one's details instead, and marks
// the ones changed.
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "@sdwa/components";
import type { Chosen } from "./choose.ts";
import { copy } from "./copy.ts";

/** More than this many and the grid scrolls (4 rows of 3), so say so. */
const VISIBLE = 12;

/** An object URL for the file while the component is shown; undefined where the browser can't make one. */
function usePreviewUrl(file: File): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

function Placeholder({ item, className = "" }: { item: Chosen; className?: string }) {
  return (
    <div
      className={`flex items-center justify-center bg-secondary p-2 text-center text-sm text-muted-foreground ${className}`}
    >
      {item.kind === "video" ? copy.choose.videoNoPreview : copy.choose.noPreview}
    </div>
  );
}

/** A tile's picture. The tile's button carries the name, so the picture itself is decorative. */
export function Thumb({ item, className = "" }: { item: Chosen; className?: string }) {
  const url = usePreviewUrl(item.file);
  const [broken, setBroken] = useState(false);
  if (broken || !url) return <Placeholder item={item} className={className} />;
  if (item.kind === "video") {
    return (
      <div className={`relative ${className}`}>
        {/* #t=0.1 asks for the first frame, so phones show a picture, not black. */}
        <video
          src={`${url}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          aria-hidden
          onError={() => setBroken(true)}
          className="size-full bg-secondary object-cover"
        />
        <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/75 px-2 text-sm text-white">
          {copy.choose.video}
        </span>
      </div>
    );
  }
  return <img src={url} alt="" onError={() => setBroken(true)} className={`bg-secondary object-cover ${className}`} />;
}

/** The photo at full width, or the video, playable. */
function FullSize({ item }: { item: Chosen }) {
  const url = usePreviewUrl(item.file);
  const [broken, setBroken] = useState(false);
  if (broken || !url) {
    return (
      <p className="rounded bg-secondary p-8 text-center text-base text-muted-foreground">
        {item.kind === "video" ? copy.choose.videoNoPreview : copy.choose.viewerNoPreview}
      </p>
    );
  }
  if (item.kind === "video") {
    return (
      <video
        src={url}
        controls
        playsInline
        onError={() => setBroken(true)}
        className="max-h-[70vh] w-full rounded bg-black"
      />
    );
  }
  return (
    <img
      src={url}
      alt={item.file.name}
      onError={() => setBroken(true)}
      className="max-h-[70vh] w-full rounded bg-secondary object-contain"
    />
  );
}

export function Gallery({
  items,
  onRemove,
  onOpen,
  tileLabel = (item) => copy.choose.seeBigger(item.file.name),
  changed = () => false,
}: {
  items: Chosen[];
  /** Gives each tile its ✕. */
  onRemove?: (key: string) => void;
  /** What tapping a tile does; the full-size viewer when not given. */
  onOpen?: (item: Chosen) => void;
  /** The tile's accessible name. */
  tileLabel?: (item: Chosen) => string;
  /** Whether the tile shows the Changed badge. */
  changed?: (key: string) => boolean;
}) {
  const [viewing, setViewing] = useState<Chosen>();
  const list = useRef<HTMLUListElement>(null);
  // After a ✕, focus moves to the next tile's ✕ (or the previous one), so a
  // keyboard or screen-reader user is not dropped at the top of the page.
  const [focusAfterRemove, setFocusAfterRemove] = useState<string>();
  useEffect(() => {
    if (!focusAfterRemove) return;
    list.current?.querySelector<HTMLElement>(`li[data-key="${focusAfterRemove}"] > button:last-of-type`)?.focus();
  }, [focusAfterRemove, items]);

  const takeOut = (index: number) => {
    const item = items[index]!;
    setFocusAfterRemove((items[index + 1] ?? items[index - 1])?.key);
    onRemove?.(item.key);
  };

  return (
    <div className="flex flex-col gap-1">
      {/* 3 columns, at most 4 rows tall before it scrolls. Container query
          units keep that right at any width: a tile is (width - 2 gaps) / 3. */}
      <div className="@container overflow-hidden rounded-lg border border-border">
        <ul
          ref={list}
          aria-label={copy.choose.gallery}
          className="grid max-h-[calc((100cqw-1rem)/3*4+1.5rem)] grid-cols-3 gap-2 overflow-y-auto"
        >
          {items.map((item, index) => (
            <li key={item.key} data-key={item.key} className="relative aspect-square">
              {/* The tile and its ✕ are drawn here, not at the large size. */}
              <Button
                variant="quiet"
                size="default"
                aria-label={tileLabel(item)}
                onPress={() => (onOpen ? onOpen(item) : setViewing(item))}
                className="absolute inset-0 block size-full overflow-hidden rounded-none p-0"
              >
                <Thumb item={item} className="size-full" />
              </Button>
              {/* In words and with an icon, never colour alone (#31). The tile's name says it too. */}
              {changed(item.key) && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1 top-1 rounded bg-primary px-2 py-0.5 text-sm font-medium text-primary-foreground"
                >
                  ✎ {copy.change.changed}
                </span>
              )}
              {onRemove && (
                <Button
                  variant="quiet"
                  size="default"
                  aria-label={copy.choose.takeOut(item.file.name)}
                  onPress={() => takeOut(index)}
                  className="absolute right-1 top-1 size-12 rounded-full bg-black/75 p-0 text-xl text-white data-[hovered]:bg-black/90"
                >
                  <span aria-hidden>✕</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {items.length > VISIBLE && <p className="text-sm text-muted-foreground">{copy.choose.scrollHint(items.length)}</p>}

      <ModalOverlay
        isDismissable
        isOpen={viewing !== undefined}
        onOpenChange={(open) => {
          if (!open) setViewing(undefined);
        }}
      >
        <Modal size="wide" className="p-3">
          <Dialog
            aria-label={viewing ? copy.choose.bigger(viewing.file.name) : undefined}
            className="flex max-h-[90vh] flex-col gap-3 overflow-y-auto outline-none"
          >
            {viewing && (
              <>
                <FullSize item={viewing} />
                <p className="truncate text-center text-base text-muted-foreground">{viewing.file.name}</p>
                <Button variant="primary" className="w-full" onPress={() => setViewing(undefined)}>
                  {copy.choose.close}
                </Button>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

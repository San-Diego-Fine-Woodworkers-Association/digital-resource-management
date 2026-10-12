// What the service takes (#18), and the rules the page and the service share,
// so a file the page accepts is one the service accepts too.
//
// A file's type always comes from its first bytes, never from its name or the
// type the browser reported (#23). The page checks the same way so a member
// hears about a wrong file as soon as it is chosen; the service checks again
// and its answer is the one that counts.

export const LIMITS = {
  photoMaxBytes: 50 * 1024 * 1024,
  videoMaxBytes: 1024 * 1024 * 1024,
  /** Items per Submission. */
  maxItems: 50,
  /** Videos per Submission. */
  maxVideos: 10,
  /** Bytes per Submission, all Items together. */
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
};

export type Limits = typeof LIMITS;

export type MediaKind = "photo" | "video";

export interface DetectedType {
  kind: MediaKind;
  mime: string;
  /** The extension the stored File name gets. */
  extension: string;
}

/** How many leading bytes `detectType` needs. */
export const HEAD_BYTES = 32;

// ISO-BMFF (`....ftyp<brand>`) major brands. HEIC/HEIF stills and MP4/MOV
// videos share the container, so the brand decides which it is. Anything
// else in that container (AVIF, 3GP, M4A audio, ...) is not taken.
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "MSNV", "XAVC"]);
const MOV_BRANDS = new Set(["qt  "]);
// Older QuickTime files have no ftyp box and start straight with one of these.
const MOV_FIRST_BOXES = new Set(["moov", "mdat", "wide"]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(head: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...head.subarray(from, to));
}

/** The type of a file from its first bytes (at least `HEAD_BYTES` of them when the file has that many). */
export function detectType(head: Uint8Array): DetectedType | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: "photo", mime: "image/jpeg", extension: "jpg" };
  }
  if (head.length >= 8 && PNG_SIGNATURE.every((b, i) => head[i] === b)) {
    return { kind: "photo", mime: "image/png", extension: "png" };
  }
  if (head.length >= 12) {
    const box = ascii(head, 4, 8);
    if (box === "ftyp") {
      const brand = ascii(head, 8, 12);
      if (HEIC_BRANDS.has(brand)) return { kind: "photo", mime: "image/heic", extension: "heic" };
      if (HEIF_BRANDS.has(brand)) return { kind: "photo", mime: "image/heif", extension: "heif" };
      if (MP4_BRANDS.has(brand)) return { kind: "video", mime: "video/mp4", extension: "mp4" };
      if (MOV_BRANDS.has(brand)) return { kind: "video", mime: "video/quicktime", extension: "mov" };
    } else if (MOV_FIRST_BOXES.has(box)) {
      return { kind: "video", mime: "video/quicktime", extension: "mov" };
    }
  }
  return undefined;
}

/**
 * Why a file cannot be added. Each has its own plain reason on the page, and
 * the service answers with the same words as its `error`.
 */
export type Refusal = "wrong_type" | "too_big" | "too_many" | "too_many_videos" | "too_much_in_all";

/** What a Submission already holds. */
export interface Tally {
  items: number;
  videos: number;
  bytes: number;
}

/** Whether one file, by itself, can be taken: a type we take, and not too big for its kind. */
export function checkFile(type: DetectedType | undefined, size: number, limits: Limits = LIMITS): Refusal | undefined {
  if (!type) return "wrong_type";
  if (size > (type.kind === "photo" ? limits.photoMaxBytes : limits.videoMaxBytes)) return "too_big";
  return undefined;
}

/**
 * Whether a Submission has room for one more file of this size (and kind,
 * when it is known: the video count is skipped without one).
 */
export function checkRoom(kind: MediaKind | undefined, size: number, tally: Tally, limits: Limits = LIMITS): Refusal | undefined {
  if (tally.items >= limits.maxItems) return "too_many";
  if (kind === "video" && tally.videos >= limits.maxVideos) return "too_many_videos";
  if (tally.bytes + size > limits.maxTotalBytes) return "too_much_in_all";
  return undefined;
}

const REFUSALS: readonly string[] = ["wrong_type", "too_big", "too_many", "too_many_videos", "too_much_in_all"];

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "string" && REFUSALS.includes(value);
}

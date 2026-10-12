// Step 1's rules: which of the files a member picks can be added (#54). The
// same allowlist and limits as the service (shared/media.ts), checked the
// same way, by the file's first bytes, so a member hears about a wrong file
// at once instead of after sending. Each file is judged on its own: the ones
// that fit are kept, and each one that doesn't gets its own reason.
import { checkFile, checkRoom, detectType, HEAD_BYTES, type MediaKind, type Refusal } from "../shared/media.ts";

/** A file the member has chosen and can still take out. */
export interface Chosen {
  /** Stable for the page's lifetime (React keys, removal). */
  key: string;
  file: File;
  kind: MediaKind;
}

/** A file that could not be added, and why. */
export interface Refused {
  name: string;
  refusal: Refusal;
  kind: MediaKind | undefined;
  size: number;
}

let nextKey = 1;

async function head(file: File): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  } catch {
    // Unreadable (for example, a file the phone has not finished downloading
    // from the cloud): treat it as a type we can't take.
    return new Uint8Array();
  }
}

/** Splits newly picked files into those added to `current` and those refused, in the order picked. */
export async function choose(current: Chosen[], picked: File[]): Promise<{ added: Chosen[]; refused: Refused[] }> {
  const types = await Promise.all(picked.map(async (f) => detectType(await head(f))));
  const tally = {
    items: current.length,
    videos: current.filter((c) => c.kind === "video").length,
    bytes: current.reduce((sum, c) => sum + c.file.size, 0),
  };
  const added: Chosen[] = [];
  const refused: Refused[] = [];
  picked.forEach((file, i) => {
    const type = types[i];
    const refusal = checkFile(type, file.size) ?? checkRoom(type?.kind, file.size, tally);
    if (refusal || !type) {
      refused.push({ name: file.name, refusal: refusal ?? "wrong_type", kind: type?.kind, size: file.size });
      return;
    }
    tally.items++;
    tally.bytes += file.size;
    if (type.kind === "video") tally.videos++;
    added.push({ key: String(nextKey++), file, kind: type.kind });
  });
  return { added, refused };
}

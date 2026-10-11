// What a staged file really is, from its first bytes, never from its name or
// the type the browser reported (#23). This slice accepts photos only: JPEG,
// PNG and HEIC/HEIF (#18). Videos arrive with #55, and the full allowlist and
// rejection reasons with #54.
import { open } from "node:fs/promises";

export interface DetectedType {
  mime: string;
  extension: string;
}

// ISO-BMFF major brands for HEIC/HEIF stills.
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);

export function detectPhoto(head: Buffer): DetectedType | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: "png" };
  }
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (HEIC_BRANDS.has(brand)) return { mime: "image/heic", extension: "heic" };
    if (HEIF_BRANDS.has(brand)) return { mime: "image/heif", extension: "heif" };
  }
  return undefined;
}

export async function detectPhotoFile(filePath: string): Promise<DetectedType | undefined> {
  const fh = await open(filePath, "r");
  try {
    const head = Buffer.alloc(32);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return detectPhoto(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

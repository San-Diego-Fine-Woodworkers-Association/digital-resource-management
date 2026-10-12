// What a staged file really is, from its first bytes, never from its name or
// the type the browser reported (#23). The allowlist itself (JPEG, PNG,
// HEIC/HEIF, MP4 and MOV, #18) is in shared/media.ts, so the page checks the
// same way.
import { open } from "node:fs/promises";
import { detectType, HEAD_BYTES, type DetectedType } from "../shared/media.ts";

export async function detectFile(filePath: string): Promise<DetectedType | undefined> {
  const fh = await open(filePath, "r");
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return detectType(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

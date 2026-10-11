// How the page talks to the service when sending. The page depends only on
// the `Sender` interface, so component tests (seam 2) swap in a fake; the real
// one is headless Uppy with its tus plugin (#20), then one JSON call to hand
// the arrived photo to ResourceSpace.
import Uppy from "@uppy/core";
import Tus from "@uppy/tus";

export interface SendDetails {
  title: string;
  rightsConfirmed: true;
}

export interface SendEvents {
  /** Percent of the file that has reached the service, 0 to 100. */
  onProgress: (percent: number) => void;
  /** The whole file has arrived; the service is handing it to ResourceSpace. */
  onFinishing: () => void;
}

export type SendResult =
  | { ok: true }
  /** not_a_photo: the service looked inside and it is not a photo it takes. failed: anything else; trying again may work. */
  | { ok: false; reason: "not_a_photo" | "failed" };

export interface Sender {
  /** Sends one photo. Calling it again for the same file after a failure resumes and never duplicates. */
  send(file: File, details: SendDetails, events: SendEvents): Promise<SendResult>;
}

const FILES_ENDPOINT = "/upload/api/files/";
const ITEMS_ENDPOINT = "/upload/api/items";

/** #17: small chunks (5–8 MB) keep each request well inside Traefik's 60 s read timeout. */
const CHUNK_SIZE = 5 * 1024 * 1024;

export function createSender(): Sender {
  const uppy = new Uppy({ autoProceed: false }).use(Tus, {
    endpoint: FILES_ENDPOINT,
    chunkSize: CHUNK_SIZE,
    // The full retry schedule and its states are #58; this rides out a blip.
    retryDelays: [0, 1000, 3000, 5000],
    limit: 1,
    // Only the file's name goes to the service (as metadata it treats as untrusted).
    allowedMetaFields: ["name"],
    // Resuming after the tab is closed is out of scope (#20).
    storeFingerprintForResuming: false,
    removeFingerprintOnSuccess: true,
  });

  // The photo being sent: Uppy's id for it, and the service's upload id once
  // it has fully arrived (so trying again only repeats the hand-off).
  let current: { file: File; fileId: string; uploadId?: string } | undefined;

  async function upload(file: File, onProgress: (p: number) => void): Promise<string | undefined> {
    if (current?.file === file && current.uploadId) return current.uploadId;
    const progress = (f: { id: string } | undefined, p: { bytesUploaded: number; bytesTotal: number | null }) => {
      if (f && f.id === current?.fileId && p.bytesTotal) onProgress(Math.floor((p.bytesUploaded / p.bytesTotal) * 100));
    };
    uppy.on("upload-progress", progress);
    try {
      let result;
      if (current?.file === file) {
        // Resumes from the last chunk the service confirmed.
        result = await uppy.retryUpload(current.fileId);
      } else {
        // A different photo: forget the previous one, sent or not.
        for (const f of uppy.getFiles()) uppy.removeFile(f.id);
        current = { file, fileId: uppy.addFile({ name: file.name, type: file.type, data: file, source: "local" }) };
        result = await uppy.upload();
      }
      const entry = current;
      const done = result?.successful?.find((f) => f.id === entry.fileId);
      const url = done?.uploadURL ?? done?.response?.uploadURL;
      if (!url) return undefined;
      entry.uploadId = url.split("/").filter(Boolean).pop();
      return entry.uploadId;
    } catch {
      return undefined;
    } finally {
      uppy.off("upload-progress", progress);
    }
  }

  return {
    async send(file, details, events) {
      const uploadId = await upload(file, events.onProgress);
      if (!uploadId) return { ok: false, reason: "failed" };
      events.onProgress(100);
      events.onFinishing();
      try {
        const res = await fetch(ITEMS_ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uploadId, title: details.title, rightsConfirmed: details.rightsConfirmed }),
        });
        if (res.ok) return { ok: true };
        if (res.status === 415) return { ok: false, reason: "not_a_photo" };
        return { ok: false, reason: "failed" };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
  };
}

// STUB engine shared by the variants: limits checks + fake uploading.
// No network. Mirrors the decided behaviour: chunk retry resumes in place.
import { useCallback, useEffect, useRef, useState } from "react";
import { LIMITS, PHOTO_EXT, VIDEO_EXT, formatSize } from "./limits";
import { EMPTY_META, type Meta } from "./fields";

export type Item = {
  id: string;
  file: File;
  kind: "photo" | "video";
  url: string;
  progress: number; // 0..100
  status: "waiting" | "sending" | "retrying" | "done";
  overrides: Partial<Meta>;
};
export type Rejection = { name: string; reason: string };

let nextId = 1;
const ext = (n: string) => n.split(".").pop()?.toLowerCase() ?? "";

export function effective(item: Item, batch: Meta): Meta {
  const o = Object.fromEntries(
    Object.entries(item.overrides).filter(([, v]) => v !== "" && v !== undefined),
  );
  return { ...batch, ...o };
}

export function useSubmission(opts: { flaky: boolean; autoStart: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const [batch, setBatch] = useState<Meta>(EMPTY_META);
  const [started, setStarted] = useState(false);
  const flakyUsed = useRef(new Set<string>());

  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const bad: Rejection[] = [];
      const good: Item[] = [];
      let count = items.length;
      let videos = items.filter((i) => i.kind === "video").length;
      let total = items.reduce((s, i) => s + i.file.size, 0);
      for (const file of Array.from(list)) {
        const e = ext(file.name);
        const kind = PHOTO_EXT.includes(e) ? "photo" : VIDEO_EXT.includes(e) ? "video" : null;
        if (!kind) {
          bad.push({ name: file.name, reason: "This kind of file can't be added. Photos (JPG, PNG, HEIC) and videos (MP4, MOV) only." });
        } else if (kind === "photo" && file.size > LIMITS.photoMaxBytes) {
          bad.push({ name: file.name, reason: `Too big (${formatSize(file.size)}). Photos can be up to 50 MB.` });
        } else if (kind === "video" && file.size > LIMITS.videoMaxBytes) {
          bad.push({ name: file.name, reason: `Too big (${formatSize(file.size)}). Videos can be up to 1 GB. Try sending it as a shorter clip.` });
        } else if (count >= LIMITS.maxItems) {
          bad.push({ name: file.name, reason: "That's the most we can take at once (50). Send this one in your next batch." });
        } else if (kind === "video" && videos >= LIMITS.maxVideos) {
          bad.push({ name: file.name, reason: "That's the most videos we can take at once (10). Send this one in your next batch." });
        } else if (total + file.size > LIMITS.maxTotalBytes) {
          bad.push({ name: file.name, reason: "This batch is getting too large (4 GB). Send this one in your next batch." });
        } else {
          count++;
          total += file.size;
          if (kind === "video") videos++;
          good.push({ id: String(nextId++), file, kind, url: URL.createObjectURL(file), progress: 0, status: "waiting", overrides: {} });
        }
      }
      setItems((p) => [...p, ...good]);
      setRejected(bad);
      if (opts.autoStart && good.length) setStarted(true);
    },
    [items, opts.autoStart],
  );

  const remove = (id: string) => setItems((p) => p.filter((i) => i.id !== id));
  const setOverride = (id: string, patch: Partial<Meta>) =>
    setItems((p) => p.map((i) => (i.id === id ? { ...i, overrides: { ...i.overrides, ...patch } } : i)));
  const start = () => setStarted(true);
  const reset = () => { setItems([]); setRejected([]); setBatch(EMPTY_META); setStarted(false); flakyUsed.current.clear(); };

  // Fake sender: two items at a time, ~25 MB/s-ish scaled so demos are short.
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => {
      setItems((prev) => {
        let active = prev.filter((i) => i.status === "sending" || i.status === "retrying").length;
        return prev.map((i) => {
          if (i.status === "done") return i;
          if (i.status === "waiting") {
            if (active >= 2) return i;
            active++;
            return { ...i, status: "sending" };
          }
          // flaky mode: the first video (or first item) drops once at ~60%, then resumes
          const victim = prev.find((x) => x.kind === "video") ?? prev[0];
          if (opts.flaky && i.id === victim?.id && i.progress >= 60 && !flakyUsed.current.has(i.id)) {
            flakyUsed.current.add(i.id);
            setTimeout(() => setItems((p) => p.map((x) => (x.id === i.id ? { ...x, status: "sending" } : x))), 2500);
            return { ...i, status: "retrying" };
          }
          if (i.status === "retrying") return i;
          const step = i.kind === "video" ? 3 : 12;
          const progress = Math.min(100, i.progress + step);
          return { ...i, progress, status: progress >= 100 ? "done" : "sending" };
        });
      });
    }, 250);
    return () => clearInterval(t);
  }, [started, opts.flaky]);

  const doneCount = items.filter((i) => i.status === "done").length;
  const allDone = items.length > 0 && doneCount === items.length;
  const overall = items.length ? Math.round(items.reduce((s, i) => s + i.progress, 0) / items.length) : 0;
  const photos = items.filter((i) => i.kind === "photo").length;
  const videos = items.length - photos;

  return { items, rejected, batch, setBatch, addFiles, remove, setOverride, start, started, reset, doneCount, allDone, overall, photos, videos };
}
export type Submission = ReturnType<typeof useSubmission>;

export function countWords(photos: number, videos: number) {
  const p = photos ? `${photos} photo${photos === 1 ? "" : "s"}` : "";
  const v = videos ? `${videos} video${videos === 1 ? "" : "s"}` : "";
  return [p, v].filter(Boolean).join(" and ");
}

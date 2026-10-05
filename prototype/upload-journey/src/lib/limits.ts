// Decided on the "upload limits" ticket (map 12).
export const LIMITS = {
  photoMaxBytes: 50 * 1024 * 1024,
  videoMaxBytes: 1024 * 1024 * 1024,
  maxItems: 50,
  maxVideos: 10,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
};

export const PHOTO_EXT = ["jpg", "jpeg", "png", "heic", "heif"];
export const VIDEO_EXT = ["mp4", "mov"];
export const ACCEPT = [...PHOTO_EXT, ...VIDEO_EXT].map((e) => "." + e);

export const LIMITS_SENTENCE =
  "Up to 50 photos and videos at a time. Photos up to 50 MB, videos up to 1 GB.";

export function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  if (bytes >= 1024 ** 2) return Math.round(bytes / 1024 ** 2) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

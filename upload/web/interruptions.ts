// What a phone and a browser do to a page that is sending (#59, #30): the
// screen going to sleep, the connection coming and going, the tab going to
// the background (phones freeze it there), and the member leaving the page.
// Each is a small hook; SendMedia.tsx decides what to do about them.
import { useEffect, useRef } from "react";

/**
 * The browser's events that matter while sending. `onOnline` and
 * `onForeground` are only hints: being "online" does not prove the service
 * can be reached, so they only make the next try due now.
 */
export function usePageEvents(handlers: {
  onOnline: () => void;
  onOffline: () => void;
  /** The page is showing again: back from the background, or from another tab. */
  onForeground: () => void;
  /** The window has the focus again (on a computer, back from another window). */
  onFocus: () => void;
}) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const online = () => latest.current.onOnline();
    const offline = () => latest.current.onOffline();
    const visible = () => {
      if (document.visibilityState === "visible") latest.current.onForeground();
    };
    const focus = () => latest.current.onFocus();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", focus);
    };
  }, []);
}

/** The browser says there is no connection at all. Only `false` is to be believed. */
export const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/**
 * Keeps the screen awake while `active`, where the browser can (the Screen
 * Wake Lock API). The browser lets go of it whenever the page is hidden, so
 * it is asked for again when the page shows again. Where it can't be had
 * (not supported, refused, low battery), nothing is said: the keep-awake
 * line on the page asks the member instead.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!active || !wakeLock) return;
    let lock: WakeLockSentinelLike | undefined;
    let asking = false;
    let stopped = false;
    const acquire = () => {
      if (stopped || asking || (lock && !lock.released) || document.visibilityState !== "visible") return;
      asking = true;
      wakeLock
        .request("screen")
        .then((sentinel) => {
          if (stopped) void sentinel.release().catch(() => {});
          else lock = sentinel;
        })
        .catch(() => {})
        .finally(() => {
          asking = false;
        });
    };
    const visible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", visible);
      if (lock && !lock.released) void lock.release().catch(() => {});
    };
  }, [active]);
}

/**
 * The browser's own "Leave this page?" warning while `active` (its wording
 * can't be changed). Only then: a page that always warns teaches people to
 * ignore it.
 */
export function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need this as well.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

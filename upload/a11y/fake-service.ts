// The built page (dist/web) in a real browser, with the upload service faked
// at the network: every request the page makes is answered here, through
// Playwright's routing, so no server or port is needed. The page is served as
// the service serves it (server/app.ts): the boot data in the HTML and the
// same Content-Security-Policy. Each test decides how the service answers
// each photo's hand-off, which is how it drives every Item state (#30).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import type { Boot } from "../shared/boot.ts";
import type { Options } from "../shared/details.ts";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");

/** Never a real address: everything is answered by the routes below. */
export const ORIGIN = "http://localhost:5199";

// As server/app.ts sends it, so the check runs under the real policy.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const USER = { name: "Pat Member", email: "pat@example.org" };

export const BOOTS = {
  app: {
    screen: "app",
    user: USER,
    signOutUrl: "https://auth.example.org/logout",
    renewUrl: "https://www.example.org/renew",
    switchAccountUrl: "https://auth.example.org/logout?redirect=signed-in",
  },
  notMember: { screen: "not-member", user: USER, renewUrl: "https://www.example.org/renew", signOutUrl: "https://auth.example.org/logout" },
  signedIn: { screen: "signed-in" },
  paused: { screen: "paused" },
  unavailable: { screen: "unavailable" },
} satisfies Record<string, Boot>;

export const OPTIONS: Options = {
  programevent: ["Classes & Workshops", "Old Tool Swap Meet", "Toy Drive"],
  subjecttype: ["Finished Piece", "Work in Progress", "Tool or Equipment"],
  location: ["Shop", "Swap Meet"],
};

/** How the service answers one request: a reply, no answer yet, or a dropped connection. */
export type Answer = { status: number; json?: unknown } | "hold" | "drop";

export interface Behaviour {
  /** The hand-off of the photo or video with this name (POST /api/items), on its `attempt`th try (1 for the first). */
  handOff: (name: string, attempt: number) => Answer;
  /** Starting the upload of this file (tus POST). "hold" keeps it Sending. */
  upload: (name: string) => "ok" | "hold";
  /** Whether the club's lists load. */
  options: "ok" | "fail";
}

const SENT: Answer = { status: 200, json: { status: "sent" } };

/**
 * Serves the page with `boot` at `pathname` and answers its API calls as
 * `behaviour` says. Returns the behaviour, so a test can change it part way.
 */
export async function openPage(page: Page, boot: Boot, behaviour: Partial<Behaviour> = {}, pathname = "/upload/") {
  const b: Behaviour = { handOff: () => SENT, upload: () => "ok", options: "ok", ...behaviour };
  const html = (await readFile(path.join(DIST, "index.html"), "utf8")).replace(
    "</head>",
    `<script type="application/json" id="boot">${JSON.stringify(boot).replace(/</g, "\\u003c")}</script></head>`,
  );
  const uploads = new Map<string, { name: string; length: number }>();
  const attempts = new Map<string, number>();
  let next = 0;

  const answer = async (route: Route, a: Answer) => {
    if (a === "hold") return; // never answered: the page waits
    if (a === "drop") return route.abort("connectionreset");
    return route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.json ?? {}) });
  };

  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();

    if (p.startsWith("/upload/assets/")) {
      const file = path.join(DIST, path.normalize(p.slice("/upload/".length)));
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : undefined;
      return route.fulfill({ body: await readFile(file), contentType: type, headers: { "content-security-policy": CSP } });
    }
    if (p === "/upload/api/options") {
      return b.options === "ok" ? route.fulfill({ json: { options: OPTIONS } }) : route.fulfill({ status: 502, json: { error: "unavailable" } });
    }
    if (p === "/upload/api/session") return route.fulfill({ json: { ok: true } });
    if (p === "/upload/api/submissions" && method === "POST") return route.fulfill({ status: 201, json: { submissionId: "sub-1" } });
    if (p.startsWith("/upload/api/submissions/")) return route.fulfill({ status: 204 });

    // tus: create, then one PATCH with the whole file.
    if (p === "/upload/api/files/" && method === "POST") {
      const meta = Object.fromEntries(
        (req.headers()["upload-metadata"] ?? "").split(",").map((kv) => {
          const [k, v = ""] = kv.trim().split(" ");
          return [k, Buffer.from(v, "base64").toString()];
        }),
      );
      const name = meta.name ?? "unknown";
      if (b.upload(name) === "hold") return;
      const id = `u${++next}`;
      uploads.set(id, { name, length: Number(req.headers()["upload-length"] ?? 0) });
      return route.fulfill({
        status: 201,
        headers: { "tus-resumable": "1.0.0", location: `${ORIGIN}/upload/api/files/${id}`, "access-control-expose-headers": "location" },
      });
    }
    if (p.startsWith("/upload/api/files/")) {
      const up = uploads.get(p.split("/").pop()!);
      return route.fulfill({
        status: method === "HEAD" ? 200 : 204,
        headers: { "tus-resumable": "1.0.0", "upload-offset": String(up?.length ?? 0), "upload-length": String(up?.length ?? 0) },
      });
    }
    if (p === "/upload/api/items" && method === "POST") {
      const { uploadId } = JSON.parse(req.postData() ?? "{}") as { uploadId: string };
      const name = uploads.get(uploadId)?.name ?? "unknown";
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      return answer(route, b.handOff(name, attempt));
    }

    // The page itself, at any path under /upload/.
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": CSP },
      body: html,
    });
  });
  await page.goto(`${ORIGIN}${pathname}`);
  return b;
}

/** A photo the browser can draw: a PNG made on a canvas in the page, so the thumbnails look real. */
export async function photo(page: Page, name: string, hue = 30) {
  const base64 = await page.evaluate((h) => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 240;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 320, 240);
    grad.addColorStop(0, `hsl(${h} 45% 70%)`);
    grad.addColorStop(1, `hsl(${h} 50% 35%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 240);
    return c.toDataURL("image/png").split(",")[1]!;
  }, hue);
  return { name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

/** A video by its first bytes (a QuickTime header): enough to be taken, never playable, so it shows its placeholder. */
export function video(name: string) {
  const head = Buffer.from("\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00", "latin1");
  return { name, mimeType: "video/quicktime", buffer: Buffer.concat([head, Buffer.alloc(64)]) };
}

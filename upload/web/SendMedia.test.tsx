// Seam 2: the page flow, with the service's API faked behind the Sender
// interface. Choosing many photos and videos at once, the gallery and the
// limits (#54); then Title, rights, Send and thank-you (#53).
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Boot } from "../shared/boot.ts";
import { App } from "./App.tsx";
import type { SendDetails, SendEvents, SendResult, Sender } from "./send.ts";

const boot: Boot = {
  screen: "app",
  user: { name: "Pat Member", email: "pat@example.org" },
  signOutUrl: "https://auth.example.org/logout",
};

interface Call {
  /** Which Submission (1, 2, ...) it was sent in. */
  submission: number;
  file: File;
  details: SendDetails;
  events: SendEvents;
  finish: (result: SendResult) => void;
}

/** A fake service: each send waits until the test decides how it ends. */
function fakeSender() {
  const calls: Call[] = [];
  let submissions = 0;
  const sender: Sender = {
    begin: () => {
      const submission = ++submissions;
      return {
        send: (file, details, events) =>
          new Promise((resolve) => {
            calls.push({ submission, file, details, events, finish: resolve });
          }),
      };
    },
  };
  return { sender, calls, submissions: () => submissions };
}

const MB = 1024 * 1024;

/** A file whose first bytes are `head`; `size` pretends it is bigger without allocating it. */
function file(name: string, head: number[] | string, type: string, size?: number): File {
  const bytes = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
  const f = new File([new Uint8Array([...bytes, ...Array(32).fill(0)])], name, { type });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
}

const photo = (name = "IMG_4821.JPG", size?: number) => file(name, [0xff, 0xd8, 0xff, 0xe0], "image/jpeg", size);
const heic = (name = "IMG_5000.HEIC") => file(name, "\x00\x00\x00\x18ftypheic", "image/heic");
const video = (name = "IMG_2043.MOV", size?: number) => file(name, "\x00\x00\x00\x14ftypqt  ", "video/quicktime", size);
const gif = (name: string) => file(name, "GIF89a", "image/jpeg");

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input;
}

type User = ReturnType<typeof userEvent.setup>;

async function pick(user: User, files: File[]) {
  await user.upload(fileInput(), files);
  // Each file's first bytes are read before it is added.
  await waitFor(() => expect(fileInput()).toBeInTheDocument());
  await act(async () => {});
}

const tiles = () => screen.queryAllByRole("button", { name: /^See .* bigger$/ });

async function describeAndSend(user: User, title = "Dovetail class, May 3") {
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), title);
  await user.click(screen.getByRole("checkbox", { name: /I took these, or I have permission to share them with SDFWA/ }));
  await user.click(screen.getByRole("button", { name: "Send them" }));
}

describe("choosing many photos and videos", () => {
  it("says what can be sent before anything is chosen", () => {
    render(<App boot={boot} sender={fakeSender().sender} />);

    expect(
      screen.getByText("Up to 50 photos and videos at a time. Photos up to 50 MB, videos up to 1 GB."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose photos and videos" })).toBeInTheDocument();
    expect(fileInput()).toHaveAttribute("multiple");
    expect(fileInput().accept.split(",")).toEqual(
      expect.arrayContaining(["image/jpeg", "image/png", "image/heic", "video/mp4", "video/quicktime", ".mov"]),
    );
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("shows all 14 of 14 chosen in a 3-column gallery that scrolls after 4 rows", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    const files = [
      ...Array.from({ length: 11 }, (_, i) => photo(`IMG_${100 + i}.JPG`)),
      heic(),
      video("IMG_2043.MOV"),
      video("clip.mov"),
    ];

    await pick(user, files);

    expect(screen.getByText("✓ 12 photos and 2 videos chosen")).toBeInTheDocument();
    expect(screen.getByText("Tap one to see it bigger. Tap the ✕ to take it out.")).toBeInTheDocument();
    const gallery = screen.getByRole("list", { name: "Your photos and videos" });
    expect(within(gallery).getAllByRole("listitem")).toHaveLength(14);
    expect(tiles()).toHaveLength(14);
    expect(screen.getAllByRole("button", { name: /^Take .* out$/ })).toHaveLength(14);
    // The layout itself is checked in a browser (see the PR's screenshots).
    expect(gallery).toHaveClass("grid-cols-3", "overflow-y-auto", "max-h-[calc((100cqw-1rem)/3*4+1.5rem)]");
    expect(screen.getByText("Scroll to see all 14.")).toBeInTheDocument();
    expect(screen.getAllByText("Video")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Add more" })).toBeInTheDocument();
  });

  it("does not mention scrolling while everything fits", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);

    await pick(user, Array.from({ length: 12 }, (_, i) => photo(`IMG_${i}.JPG`)));

    expect(tiles()).toHaveLength(12);
    expect(screen.queryByText(/Scroll to see all/)).not.toBeInTheDocument();
  });

  it("adds more to what is already chosen", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);

    await pick(user, [photo("IMG_1.JPG"), photo("IMG_2.JPG")]);
    await pick(user, [video("IMG_3.MOV")]);

    expect(tiles()).toHaveLength(3);
    expect(screen.getByText("✓ 2 photos and 1 video chosen")).toBeInTheDocument();
  });

  it("takes one out with its ✕, moving focus to the next one", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, [photo("IMG_1.JPG"), photo("IMG_2.JPG"), photo("IMG_3.JPG")]);

    await user.click(screen.getByRole("button", { name: "Take IMG_2.JPG out" }));

    expect(screen.queryByRole("button", { name: "See IMG_2.JPG bigger" })).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(2);
    expect(screen.getByText("✓ 2 photos chosen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take IMG_3.JPG out" })).toHaveFocus();
  });

  it("goes back to the start when the last one is taken out", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, [photo("IMG_1.JPG")]);

    await user.click(screen.getByRole("button", { name: "Take IMG_1.JPG out" }));

    expect(tiles()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose photos and videos" })).toBeInTheDocument();
  });

  it("opens a photo full size, and closes it again", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, [photo("IMG_1.JPG"), video("IMG_2.MOV")]);

    await user.click(screen.getByRole("button", { name: "See IMG_1.JPG bigger" }));

    const dialog = screen.getByRole("dialog", { name: "IMG_1.JPG, bigger" });
    expect(within(dialog).getByRole("img", { name: "IMG_1.JPG" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tiles()).toHaveLength(2);
  });

  it("opens a video full size, playable", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, [video("IMG_2.MOV")]);

    await user.click(screen.getByRole("button", { name: "See IMG_2.MOV bigger" }));

    const dialog = screen.getByRole("dialog", { name: "IMG_2.MOV, bigger" });
    const player = dialog.querySelector("video");
    expect(player).not.toBeNull();
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("playsinline");
  });

  it("shows a plain placeholder when the browser cannot draw a photo", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, [heic("IMG_5000.HEIC")]);

    const tile = screen.getByRole("button", { name: "See IMG_5000.HEIC bigger" });
    act(() => {
      tile.querySelector("img")!.dispatchEvent(new Event("error"));
    });

    expect(within(tile).getByText("Photo (preview not available)")).toBeInTheDocument();
  });
});

describe("files that can't be added", () => {
  async function pickAndRead(files: File[]) {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, files);
    return user;
  }

  const reasons = () => {
    const note = screen.getByText("We couldn't add some files").closest('[role="status"]') as HTMLElement;
    return within(note)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  };

  it("refuses a file by what is inside it, even when it is named like a photo, and keeps the rest", async () => {
    await pickAndRead([photo("IMG_1.JPG"), gif("IMG_2.JPG"), video("IMG_3.MOV")]);

    expect(reasons()).toEqual([
      "IMG_2.JPG: This kind of file can't be added. We can take photos (JPG, PNG, HEIC) and videos (MP4, MOV).",
    ]);
    expect(tiles()).toHaveLength(2);
    expect(screen.getByText("✓ 1 photo and 1 video chosen")).toBeInTheDocument();
  });

  it("gives each limit its own plain reason, keeping every file that fits", async () => {
    const files = [
      photo("big.jpg", 62 * MB),
      photo("ok.jpg", 50 * MB),
      video("long.mov", Math.round(1.6 * 1024 * MB)),
      // Ten videos of 400 MB: 4,050 MB so far, with ok.jpg.
      ...Array.from({ length: 10 }, (_, i) => video(`v${i}.mov`, 400 * MB)),
      video("v10.mov", 10 * MB),
      // 4,090 MB: still fits. The next one would pass 4 GB (4,096 MB).
      photo("p0.jpg", 40 * MB),
      photo("p1.jpg", 40 * MB),
    ];

    await pickAndRead(files);

    expect(reasons()).toEqual([
      "big.jpg: Too big (62 MB). Photos can be up to 50 MB.",
      "long.mov: Too big (1.6 GB). Videos can be up to 1 GB. Try sending it as a shorter clip.",
      "v10.mov: That's the most videos we can take at once (10). Send this one next time.",
      "p1.jpg: That's as much as we can take at once (4 GB in all). Send this one next time.",
    ]);
    expect(tiles()).toHaveLength(12);
    expect(screen.getByText("✓ 2 photos and 10 videos chosen")).toBeInTheDocument();
  });

  it("says when there are already as many as can be sent at once", async () => {
    const files = Array.from({ length: 52 }, (_, i) => photo(`IMG_${i}.JPG`));

    await pickAndRead(files);

    expect(reasons()).toEqual([
      "IMG_50.JPG: That's the most we can take at once. Send this one next time.",
      "IMG_51.JPG: That's the most we can take at once. Send this one next time.",
    ]);
    expect(tiles()).toHaveLength(50);
  });

  it("counts what is already chosen when more are added", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await pick(user, Array.from({ length: 49 }, (_, i) => photo(`IMG_${i}.JPG`)));

    await pick(user, [photo("one-more.jpg"), photo("too-many.jpg")]);

    expect(tiles()).toHaveLength(50);
    expect(reasons()).toEqual(["too-many.jpg: That's the most we can take at once. Send this one next time."]);
  });

  it("forgets the old reasons when the next files are chosen", async () => {
    const user = await pickAndRead([gif("bad.jpg")]);

    await pick(user, [photo("good.jpg")]);

    expect(screen.queryByText("We couldn't add some files")).not.toBeInTheDocument();
  });
});

describe("sending", () => {
  it("goes choose, Title, rights, Send, thank-you", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);

    // Step 1: choose.
    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toBeInTheDocument();
    await pick(user, [photo()]);
    expect(screen.getByText("✓ 1 photo chosen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 2: Title and the rights tick.
    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Tell us about them" })).toHaveFocus();
    expect(screen.getByText("For example: Dovetail class, May 3")).toBeInTheDocument();
    expect(screen.getByText(/means you need to fill this in/)).toBeInTheDocument();
    expect(screen.queryByText(/This will apply to all/)).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), "Dovetail class, May 3");
    await user.click(screen.getByRole("checkbox", { name: /I took these, or I have permission to share them with SDFWA/ }));
    await user.click(screen.getByRole("button", { name: "Send them" }));

    // Sending.
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
    expect(screen.getByText("Please keep this page open and your phone awake until it says thank you.")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file.name).toBe("IMG_4821.JPG");
    expect(calls[0]!.details).toEqual({ title: "Dovetail class, May 3", rightsConfirmed: true });
    act(() => calls[0]!.events.onProgress(40));
    expect(screen.getByRole("progressbar", { name: "IMG_4821.JPG" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeInTheDocument();
    act(() => calls[0]!.events.onFinishing());
    expect(screen.getByText("Finishing up…")).toBeInTheDocument();
    await act(async () => calls[0]!.finish({ ok: true }));

    // Thank-you.
    const thanks = screen.getByRole("heading", { name: "Thank you! We have your 1 photo." });
    expect(thanks).toHaveFocus();
    expect(screen.getByText("A volunteer will take a look before they appear on the SDFWA media site.")).toBeInTheDocument();
    expect(screen.getByText("You don't need to do anything else, and you can close this page.")).toBeInTheDocument();
    expect(screen.queryByText(/Step \d of 4/)).not.toBeInTheDocument();
  });

  it("sends two at a time, all in one Submission, with each one's progress", async () => {
    const user = userEvent.setup();
    const { sender, calls, submissions } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), photo("b.jpg"), video("c.mov"), photo("d.jpg"), photo("e.jpg")]);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("This will apply to all 5 of them.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), "Swap meet");
    await user.click(screen.getByRole("checkbox", { name: /I took these/ }));
    await user.click(screen.getByRole("button", { name: "Send them" }));

    const statuses = () => screen.getAllByRole("status").map((s) => s.textContent);
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(statuses()).toEqual(["Sending…", "Sending…", "Waiting…", "Waiting…", "Waiting…"]);
    expect(screen.getByText("0 of 5 sent.")).toBeInTheDocument();
    act(() => calls[1]!.events.onProgress(30));
    expect(screen.getByRole("progressbar", { name: "b.jpg" })).toHaveAttribute("aria-valuenow", "30");

    await act(async () => calls[0]!.finish({ ok: true }));
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.mov"]);
    expect(statuses()).toEqual(["✓ Sent", "Sending…", "Sending…", "Waiting…", "Waiting…"]);
    expect(screen.getByText("1 of 5 sent.")).toBeInTheDocument();

    for (let i = 1; i < 5; i++) await act(async () => calls[i]!.finish({ ok: true }));

    expect(calls).toHaveLength(5);
    expect(submissions()).toBe(1);
    expect(calls.every((c) => c.submission === 1 && c.details.title === "Swap meet")).toBe(true);
    expect(screen.getByRole("heading", { name: "Thank you! We have your 4 photos and 1 video." })).toHaveFocus();
  });

  it("shows the service's reason for one it won't take, while the rest carry on", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), video("b.mov"), photo("c.jpg")]);
    await describeAndSend(user);

    await act(async () => calls[1]!.finish({ ok: false, reason: "too_many_videos" }));

    expect(screen.getByText(/^Can't be added:/)).toHaveTextContent(
      "Can't be added: That's the most videos we can take at once (10). Send this one next time.",
    );
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.mov", "c.jpg"]);
    await act(async () => calls[0]!.finish({ ok: true }));
    await act(async () => calls[2]!.finish({ ok: true }));
    // Not the thank-you yet: the refused one is still on the list until it is taken out.
    expect(screen.getByText("2 of 3 sent.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.getByRole("heading", { name: "Thank you! We have your 2 photos." })).toBeInTheDocument();
  });

  it.each([
    ["wrong_type", "This kind of file can't be added. We can take photos (JPG, PNG, HEIC) and videos (MP4, MOV)."],
    ["too_big", "Too big (1 KB). Photos can be up to 50 MB."],
    ["too_many", "That's the most we can take at once. Send this one next time."],
    ["too_much_in_all", "That's as much as we can take at once (4 GB in all). Send this one next time."],
  ] as const)("words the service's %s refusal plainly", async (reason, words) => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg")]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: false, reason }));

    expect(screen.getByText(/^Can't be added:/)).toHaveTextContent(`Can't be added: ${words}`);
  });

  it("offers Try again when one could not be saved, and sends the same file again", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: false, reason: "failed" }));
    expect(screen.getByText("Couldn't save this one")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.file).toBe(calls[0]!.file);
    expect(calls[1]!.details).toEqual(calls[0]!.details);
    expect(calls[1]!.submission).toBe(calls[0]!.submission);
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
  });

  it("starts fresh, in a new Submission, after the thank-you", async () => {
    const user = userEvent.setup();
    const { sender, calls, submissions } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await describeAndSend(user);
    await act(async () => calls[0]!.finish({ ok: true }));

    await user.click(screen.getByRole("button", { name: "Share more photos or videos" }));

    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toHaveFocus();
    expect(screen.queryByText(/chosen/)).not.toBeInTheDocument();
    await pick(user, [video()]);
    await describeAndSend(user, "Swap meet");
    expect(submissions()).toBe(2);
    expect(calls[1]!.submission).toBe(2);
  });

  it("keeps Send unavailable until there is a Title and the rights tick, saying what is still needed", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await user.click(screen.getByRole("button", { name: "Next" }));

    const send = screen.getByRole("button", { name: "Send them" });
    expect(send).toBeDisabled();
    expect(screen.getByText("Still needed: What are these?, Permission to share")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /What are these\?/ })).toBeRequired();

    await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), "   ");
    expect(send).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), "Swap meet");
    expect(screen.getByText("Still needed: Permission to share")).toBeInTheDocument();
    expect(send).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /I took these/ }));
    expect(screen.queryByText(/Still needed/)).not.toBeInTheDocument();
    expect(send).toBeEnabled();
    await user.click(send);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.details.title).toBe("Swap meet");
  });

  it("announces each one's state, not every percent", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await describeAndSend(user);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Sending…");
    act(() => calls[0]!.events.onProgress(55));
    expect(status).not.toHaveTextContent("55");
    act(() => calls[0]!.events.onFinishing());
    expect(status).toHaveTextContent("Finishing up…");
  });

  it("never sends anything about who the member is: the service takes that from the sign-in", async () => {
    const user = userEvent.setup();
    const send = vi.fn<(file: File, details: SendDetails, events: SendEvents) => Promise<SendResult>>(
      () => new Promise(() => {}),
    );
    render(<App boot={boot} sender={{ begin: () => ({ send }) }} />);
    await pick(user, [photo()]);
    await describeAndSend(user);

    const [, details] = send.mock.calls[0]!;
    expect(Object.keys(details).sort()).toEqual(["rightsConfirmed", "title"]);
    expect(JSON.stringify(details)).not.toMatch(/Pat|pat@example/);
  });

  it("sends only once when Send is pressed twice", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), "Swap meet");
    await user.click(screen.getByRole("checkbox", { name: /I took these/ }));

    await user.dblClick(screen.getByRole("button", { name: "Send them" }));

    expect(calls).toHaveLength(1);
  });
});

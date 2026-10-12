// Seam 2: the page flow, with the service's API faked behind the Sender
// interface. Choosing many photos and videos at once, the gallery and the
// limits (#54); describing them all in Step 2 (#56); then Send and
// thank-you (#53).
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Boot } from "../shared/boot.ts";
import type { Options } from "../shared/details.ts";
import { App } from "./App.tsx";
import type { BeginResult, OptionsResult, SendEvents, SendResult, Sender, Start } from "./send.ts";

const boot: Boot = {
  screen: "app",
  user: { name: "Pat Member", email: "pat@example.org" },
  signOutUrl: "https://auth.example.org/logout",
};

/** The club's lists as the fake service gives them; deliberately not production's, so nothing can be hard-coded. */
const OPTIONS: Options = {
  programevent: ["Classes & Workshops", "Old Tool Swap Meet", "Toy Drive"],
  subjecttype: ["Finished Piece", "Work in Progress", "Tool or Equipment"],
  location: ["Shop", "Swap Meet"],
};

interface Call {
  /** Which Submission (1, 2, ...) it was sent in. */
  submission: number;
  file: File;
  events: SendEvents;
  finish: (result: SendResult) => void;
}

/**
 * A fake service: the lists load at once (unless `options` says otherwise),
 * each Submission starts as asked (or as `beginResults` says, in turn), and
 * each send waits until the test decides how it ends.
 */
function fakeSender(opts: { options?: () => Promise<OptionsResult>; beginResults?: BeginResult[] } = {}) {
  const calls: Call[] = [];
  const starts: Start[] = [];
  let submissions = 0;
  const sender: Sender = {
    options: opts.options ?? (async () => ({ ok: true, options: OPTIONS })),
    begin: async (start) => {
      starts.push(start);
      const planned = opts.beginResults?.shift();
      if (planned) return planned;
      const submission = ++submissions;
      return {
        ok: true,
        submission: {
          send: (file, events) =>
            new Promise((resolve) => {
              calls.push({ submission, file, events, finish: resolve });
            }),
        },
      };
    },
  };
  return { sender, calls, starts, submissions: () => submissions };
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

const titleBox = () => screen.getByRole("textbox", { name: /What are these\?/ });
const rightsBox = () => screen.getByRole("checkbox", { name: /I took these, or I have permission to share them with SDFWA/ });
const sendButton = () => screen.getByRole("button", { name: "Send them" });
const stillNeeded = () => screen.queryByText(/^Still needed:/)?.textContent;

/** Picks `option` in the dropdown labelled `label`, as a member would: open it, tap the choice. */
async function choose(user: User, label: RegExp, option: string) {
  await user.click(screen.getByRole("button", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Answers the required questions and ticks the rights box. */
async function fillRequired(user: User, title = "Dovetail class, May 3") {
  await screen.findByRole("button", { name: /What was the occasion\?/ });
  await user.type(titleBox(), title);
  await choose(user, /What was the occasion\?/, "Classes & Workshops");
  await user.click(screen.getByRole("checkbox", { name: "Finished Piece" }));
  await user.click(rightsBox());
}

async function describeAndSend(user: User, title = "Dovetail class, May 3") {
  await user.click(screen.getByRole("button", { name: "Next" }));
  await fillRequired(user, title);
  await user.click(sendButton());
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

describe("describing them (step 2)", () => {
  async function toStep2(sender: Sender, files = [photo()]) {
    const user = userEvent.setup();
    render(<App boot={boot} sender={sender} />);
    await pick(user, files);
    await user.click(screen.getByRole("button", { name: "Next" }));
    return user;
  }

  it("asks every question, marking the required ones and explaining the mark", async () => {
    await toStep2(fakeSender().sender);
    await screen.findByRole("button", { name: /What was the occasion\?/ });

    expect(screen.getByText(/means you need to fill this in/)).toHaveTextContent("* means you need to fill this in");
    // Required: the design system's Label shows its red * (hidden from screen
    // readers, which hear "required") only inside a field marked required.
    const field = (label: string) => screen.getByText(label).closest("[data-rac]");
    expect(titleBox()).toBeRequired();
    expect(field("What are these?")).toHaveAttribute("data-required");
    expect(field("What was the occasion?")).toHaveAttribute("data-required");
    const subjects = screen.getByRole("group", { name: /What's in them\? \(pick all that apply\)/ });
    expect(subjects).toHaveAttribute("data-required");
    // Until one is ticked, each box says the group needs an answer.
    for (const box of within(subjects).getAllByRole("checkbox")) expect(box).toBeRequired();
    expect(rightsBox()).toBeRequired();
    // Optional: not marked.
    for (const label of [
      "When were they taken?",
      "Where were they taken?",
      "Name of the class or event, if there is one",
      "Anything else we should know?",
    ]) {
      expect(field(label)).not.toHaveAttribute("data-required");
    }
    for (const name of ["Name of the class or event, if there is one", "Anything else we should know?"]) {
      expect(screen.getByRole("textbox", { name })).not.toBeRequired();
    }
    expect(screen.getByText("For example: Dovetail class, May 3")).toBeInTheDocument();
    expect(
      screen.getByText("Leave empty if you're not sure. We'll use the date on the photo when we can."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/When were they taken\?/)).toHaveAttribute("type", "date");
    // The Caption is right there, not behind a fold-out.
    expect(screen.getByRole("textbox", { name: "Anything else we should know?" }).tagName).toBe("TEXTAREA");
  });

  it("keeps Send disabled and says plainly what is still needed until every required answer is in", async () => {
    const user = await toStep2(fakeSender().sender);
    await screen.findByRole("button", { name: /What was the occasion\?/ });

    expect(sendButton()).toBeDisabled();
    expect(stillNeeded()).toBe("Still needed: What are these?, What was the occasion?, What's in them?, Permission to share");

    // Spaces are not a Title.
    await user.type(titleBox(), "   ");
    expect(stillNeeded()).toMatch(/^Still needed: What are these\?/);
    await user.type(titleBox(), "Swap meet");
    expect(stillNeeded()).toBe("Still needed: What was the occasion?, What's in them?, Permission to share");

    // Optional answers do not count.
    await user.type(screen.getByRole("textbox", { name: "Anything else we should know?" }), "A good day.");
    expect(stillNeeded()).toBe("Still needed: What was the occasion?, What's in them?, Permission to share");

    await choose(user, /What was the occasion\?/, "Old Tool Swap Meet");
    expect(stillNeeded()).toBe("Still needed: What's in them?, Permission to share");

    await user.click(screen.getByRole("checkbox", { name: "Tool or Equipment" }));
    expect(stillNeeded()).toBe("Still needed: Permission to share");
    await user.click(screen.getByRole("checkbox", { name: "Tool or Equipment" }));
    expect(stillNeeded()).toBe("Still needed: What's in them?, Permission to share");
    await user.click(screen.getByRole("checkbox", { name: "Work in Progress" }));

    expect(sendButton()).toBeDisabled();
    await user.click(rightsBox());
    expect(stillNeeded()).toBeUndefined();
    expect(sendButton()).toBeEnabled();
  });

  it("offers the club's lists exactly as the service gives them", async () => {
    const user = await toStep2(fakeSender().sender);

    await user.click(await screen.findByRole("button", { name: /What was the occasion\?/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(OPTIONS.programevent);
    await user.keyboard("{Escape}");
    const subjects = screen.getByRole("group", { name: /What's in them\?/ });
    expect(within(subjects).getAllByRole("checkbox").map((c) => c.closest("label")!.textContent)).toEqual(
      OPTIONS.subjecttype,
    );
    await user.click(screen.getByRole("button", { name: /Where were they taken\?/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(OPTIONS.location);
  });

  it("says so while the lists load, and offers Try again when they can't be had", async () => {
    let answer: (r: OptionsResult) => void = () => {};
    const options = vi.fn(() => new Promise<OptionsResult>((resolve) => (answer = resolve)));
    const user = await toStep2(fakeSender({ options }).sender);

    expect(screen.getByText("Getting the lists of choices…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /What was the occasion\?/ })).not.toBeInTheDocument();
    await act(async () => answer({ ok: false }));

    expect(screen.getByText("We couldn't get the lists of choices just now.")).toBeInTheDocument();
    await user.type(titleBox(), "Swap meet");
    await user.click(rightsBox());
    expect(sendButton()).toBeDisabled();
    expect(stillNeeded()).toBe("Still needed: What was the occasion?, What's in them?");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => answer({ ok: true, options: OPTIONS }));

    expect(options).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /What was the occasion\?/ })).toBeInTheDocument();
    // What was typed is kept.
    expect(titleBox()).toHaveValue("Swap meet");
  });

  it("starts the Submission with every answer, how many are coming, and the rights confirmation", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep2(sender, [photo("a.jpg"), video("b.mov")]);
    expect(screen.getByText("This will apply to all 2 of them.")).toBeInTheDocument();
    await fillRequired(user, "Design in Wood");
    await user.click(screen.getByRole("checkbox", { name: "Work in Progress" }));
    await user.type(screen.getByLabelText(/When were they taken\?/), "2026-05-03");
    await choose(user, /Where were they taken\?/, "Shop");
    await user.type(screen.getByRole("textbox", { name: "Name of the class or event, if there is one" }), "Hand tools");
    await user.type(screen.getByRole("textbox", { name: "Anything else we should know?" }), "Line one{Enter}Line two");

    await user.click(sendButton());

    expect(starts).toEqual([
      {
        expectedItems: 2,
        rightsConfirmed: true,
        details: {
          title: "Design in Wood",
          programevent: "Classes & Workshops",
          subjecttype: ["Finished Piece", "Work in Progress"],
          date: "2026-05-03",
          location: "Shop",
          eventname: "Hand tools",
          caption: "Line one\nLine two",
        },
      },
    ]);
  });

  it("sends a blank date as blank: the photo's own date is kept", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep2(sender);
    await fillRequired(user);

    await user.click(sendButton());

    expect(starts[0]!.details.date).toBe("");
  });

  it("lets the optional place be emptied again after one was picked", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep2(sender);
    await fillRequired(user);
    await choose(user, /Where were they taken\?/, "Swap Meet");

    await choose(user, /Where were they taken\?/, "Leave empty");
    await user.click(sendButton());

    expect(starts[0]!.details.location).toBe("");
  });

  it("asks again for a choice taken off the club's list since the page loaded", async () => {
    const now = { ...OPTIONS, programevent: ["Old Tool Swap Meet", "Toy Drive"] };
    const { sender, starts, calls } = fakeSender({
      beginResults: [{ ok: false, reason: "invalid", problems: [{ field: "programevent", problem: "not_offered" }], options: now }],
    });
    const user = await toStep2(sender);
    await fillRequired(user);

    await user.click(sendButton());

    // Still on Step 2, with the occasion emptied and marked.
    expect(screen.getByRole("heading", { level: 2, name: "Tell us about them" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("One of your choices is no longer on the list. Please choose again.");
    expect(screen.getByText("That choice is no longer on the list. Please choose again.")).toBeInTheDocument();
    expect(stillNeeded()).toBe("Still needed: What was the occasion?");
    expect(sendButton()).toBeDisabled();
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /What was the occasion\?/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(now.programevent);
    await user.click(screen.getByRole("option", { name: "Toy Drive" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("That choice is no longer on the list. Please choose again.")).not.toBeInTheDocument();

    await user.click(sendButton());
    expect(starts).toHaveLength(2);
    expect(starts[1]!.details.programevent).toBe("Toy Drive");
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
  });

  it("keeps the answers and offers Send again when the Submission could not be started", async () => {
    const { sender, starts } = fakeSender({ beginResults: [{ ok: false, reason: "failed" }] });
    const user = await toStep2(sender);
    await fillRequired(user);

    await user.click(sendButton());

    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't start sending. Please try again.");
    expect(titleBox()).toHaveValue("Dovetail class, May 3");
    await user.click(sendButton());
    expect(starts).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
  });
});

describe("sending", () => {
  it("goes choose, describe, Send, thank-you", async () => {
    const user = userEvent.setup();
    const { sender, calls, starts } = fakeSender();
    render(<App boot={boot} sender={sender} />);

    // Step 1: choose.
    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toBeInTheDocument();
    await pick(user, [photo()]);
    expect(screen.getByText("✓ 1 photo chosen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 2: describe them.
    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Tell us about them" })).toHaveFocus();
    expect(screen.queryByText(/This will apply to all/)).not.toBeInTheDocument();
    await fillRequired(user);
    await user.click(sendButton());

    // Sending.
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
    expect(screen.getByText("Please keep this page open and your phone awake until it says thank you.")).toBeInTheDocument();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.details.title).toBe("Dovetail class, May 3");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file.name).toBe("IMG_4821.JPG");
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
    const { sender, calls, starts, submissions } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), photo("b.jpg"), video("c.mov"), photo("d.jpg"), photo("e.jpg")]);
    await describeAndSend(user, "Swap meet");

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
    expect(starts).toEqual([expect.objectContaining({ expectedItems: 5 })]);
    expect(calls.every((c) => c.submission === 1)).toBe(true);
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
    const { sender, calls, starts } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: false, reason: "failed" }));
    expect(screen.getByText("Couldn't save this one")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.file).toBe(calls[0]!.file);
    expect(calls[1]!.submission).toBe(calls[0]!.submission);
    expect(starts).toHaveLength(1);
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
  });

  it("starts fresh, in a new Submission with empty answers, after the thank-you", async () => {
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
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(titleBox()).toHaveValue("");
    expect(rightsBox()).not.toBeChecked();
    await fillRequired(user, "Swap meet");
    await user.click(sendButton());
    expect(submissions()).toBe(2);
    expect(calls[1]!.submission).toBe(2);
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

  it("shows a big video Sending, then Finishing up until ResourceSpace has it, then Sent (#55)", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [video("IMG_2043.MOV", 900 * MB), photo("IMG_4821.JPG")]);
    await describeAndSend(user);
    const row = (name: string) => screen.getByText(name).closest("li")!;
    const bar = (name: string) => within(row(name)).queryByRole("progressbar");

    act(() => calls[0]!.events.onProgress(73));
    expect(within(row("IMG_2043.MOV")).getByRole("status")).toHaveTextContent("Sending…");
    expect(bar("IMG_2043.MOV")).toHaveAttribute("aria-valuenow", "73");

    // All of it has arrived; ResourceSpace is making its previews.
    act(() => calls[0]!.events.onFinishing());
    expect(within(row("IMG_2043.MOV")).getByRole("status")).toHaveTextContent(
      "Finishing up… (videos can take a few minutes)",
    );
    // Still moving, with no number that could look stuck.
    expect(bar("IMG_2043.MOV")).not.toHaveAttribute("aria-valuenow");

    // A photo finishing up is not told about videos.
    act(() => calls[1]!.events.onFinishing());
    expect(within(row("IMG_4821.JPG")).getByRole("status")).toHaveTextContent(/^Finishing up…$/);
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(within(row("IMG_4821.JPG")).getByRole("status")).toHaveTextContent("✓ Sent");
    expect(within(row("IMG_2043.MOV")).getByRole("status")).toHaveTextContent("Finishing up…");
    expect(screen.getByText("1 of 2 sent.")).toBeInTheDocument();

    await act(async () => calls[0]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo and 1 video." })).toBeInTheDocument();
  });

  it("never sends anything about who the member is: the service takes that from the sign-in", async () => {
    const user = userEvent.setup();
    const { sender, starts } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await describeAndSend(user);

    expect(Object.keys(starts[0]!).sort()).toEqual(["details", "expectedItems", "rightsConfirmed"]);
    expect(Object.keys(starts[0]!.details).sort()).toEqual(
      ["caption", "date", "eventname", "location", "programevent", "subjecttype", "title"],
    );
    expect(JSON.stringify(starts)).not.toMatch(/Pat|pat@example/);
  });

  it("starts only one Submission when Send is pressed twice", async () => {
    const user = userEvent.setup();
    const { sender, calls, starts } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo()]);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await fillRequired(user, "Swap meet");

    await user.dblClick(sendButton());

    expect(starts).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

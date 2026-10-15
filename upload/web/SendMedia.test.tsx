// Seam 2: the page flow, with the service's API faked behind the Sender
// interface. Choosing many photos and videos at once, the gallery and the
// limits (#54); describing them all in Step 2 (#56); then Send and
// thank-you (#53).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Boot } from "../shared/boot.ts";
import type { Options } from "../shared/details.ts";
import { App } from "./App.tsx";
import type { BeginResult, OptionsResult, SendEvents, SendResult, Sender, SessionCheck, Start } from "./send.ts";

const boot: Boot = {
  screen: "app",
  user: { name: "Pat Member", email: "pat@example.org" },
  signOutUrl: "https://auth.example.org/logout",
  renewUrl: "https://www.example.org/renew",
  switchAccountUrl: "https://auth.example.org/logout?redirect=signed-in",
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
  /** The page's key for the Item, which says whose answers it gets. */
  item: string;
  finish: (result: SendResult) => void;
}

/**
 * A fake service: the lists load at once (unless `options` says otherwise),
 * each Submission starts as asked (or as `beginResults` says, in turn), and
 * each send waits until the test decides how it ends.
 */
function fakeSender(
  opts: { options?: () => Promise<OptionsResult>; beginResults?: BeginResult[]; session?: () => Promise<SessionCheck> } = {},
) {
  const calls: Call[] = [];
  const starts: Start[] = [];
  let submissions = 0;
  const sender: Sender = {
    session: opts.session ?? (async () => "signed_in"),
    options: opts.options ?? (async () => ({ ok: true, options: OPTIONS })),
    begin: async (start) => {
      starts.push(start);
      const planned = opts.beginResults?.shift();
      if (planned) return planned;
      const submission = ++submissions;
      return {
        ok: true,
        submission: {
          send: (file, events, item) =>
            new Promise((resolve) => {
              calls.push({ submission, file, events, item, finish: resolve });
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
const nextButton = () => screen.getByRole("button", { name: "Next" });

/** From Step 2: Next, then Send on Step 3 without changing any single one. */
async function nextAndSend(user: User) {
  await user.click(nextButton());
  await user.click(sendButton());
  // The sending step starts its first ones once it is showing.
  await act(async () => {});
}
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
  await nextAndSend(user);
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

  it("keeps Next disabled and says plainly what is still needed until every required answer is in", async () => {
    const user = await toStep2(fakeSender().sender);
    await screen.findByRole("button", { name: /What was the occasion\?/ });

    expect(nextButton()).toBeDisabled();
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

    expect(nextButton()).toBeDisabled();
    await user.click(rightsBox());
    expect(stillNeeded()).toBeUndefined();
    expect(nextButton()).toBeEnabled();
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
    expect(nextButton()).toBeDisabled();
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
    expect(screen.getByText("This will apply to all 2 of them. You can change any single one on the next step.")).toBeInTheDocument();
    await fillRequired(user, "Design in Wood");
    await user.click(screen.getByRole("checkbox", { name: "Work in Progress" }));
    await user.type(screen.getByLabelText(/When were they taken\?/), "2026-05-03");
    await choose(user, /Where were they taken\?/, "Shop");
    await user.type(screen.getByRole("textbox", { name: "Name of the class or event, if there is one" }), "Hand tools");
    await user.type(screen.getByRole("textbox", { name: "Anything else we should know?" }), "Line one{Enter}Line two");

    await nextAndSend(user);

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

    await nextAndSend(user);

    expect(starts[0]!.details.date).toBe("");
  });

  it("lets the optional place be emptied again after one was picked", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep2(sender);
    await fillRequired(user);
    await choose(user, /Where were they taken\?/, "Swap Meet");

    await choose(user, /Where were they taken\?/, "Leave empty");
    await nextAndSend(user);

    expect(starts[0]!.details.location).toBe("");
  });

  it("asks again for a choice taken off the club's list since the page loaded", async () => {
    const now = { ...OPTIONS, programevent: ["Old Tool Swap Meet", "Toy Drive"] };
    const { sender, starts, calls } = fakeSender({
      beginResults: [{ ok: false, reason: "invalid", problems: [{ field: "programevent", problem: "not_offered" }], options: now }],
    });
    const user = await toStep2(sender);
    await fillRequired(user);

    await nextAndSend(user);

    // Back on Step 2, with the occasion emptied and marked.
    expect(screen.getByRole("heading", { level: 2, name: "Tell us about them" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("One of your choices is no longer on the list. Please choose again.");
    expect(screen.getByText("That choice is no longer on the list. Please choose again.")).toBeInTheDocument();
    expect(stillNeeded()).toBe("Still needed: What was the occasion?");
    expect(nextButton()).toBeDisabled();
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /What was the occasion\?/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(now.programevent);
    await user.click(screen.getByRole("option", { name: "Toy Drive" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("That choice is no longer on the list. Please choose again.")).not.toBeInTheDocument();

    await nextAndSend(user);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.details.programevent).toBe("Toy Drive");
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
  });

  it("keeps the answers and offers Send again when the Submission could not be started", async () => {
    const { sender, starts } = fakeSender({ beginResults: [{ ok: false, reason: "failed" }] });
    const user = await toStep2(sender);
    await fillRequired(user);

    await nextAndSend(user);

    // Still on Step 3, ready to send the same again.
    expect(screen.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't start sending. Please try again.");
    await user.click(sendButton());
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual(starts[0]);
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
  });
});

describe("sending", () => {
  it("goes choose, describe, change any single one, Send, thank-you", async () => {
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
    await user.click(nextButton());

    // Step 3: change any single one, optional; nothing is sent yet.
    expect(screen.getByText("Step 3 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toHaveFocus();
    expect(starts).toHaveLength(0);
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
    // It can be taken out while the rest carry on.
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await act(async () => calls[0]!.finish({ ok: true }));
    await act(async () => calls[2]!.finish({ ok: true }));

    expect(screen.getByRole("heading", { name: "Thank you! We have your 2 photos." })).toBeInTheDocument();
  });

  it.each([
    ["wrong_type", "This kind of file can't be added. We can take photos (JPG, PNG, HEIC) and videos (MP4, MOV)."],
    ["too_big", "Too big (1 KB). Photos can be up to 50 MB."],
    ["too_many", "That's the most we can take at once. Send this one next time."],
    ["too_much_in_all", "That's as much as we can take at once (4 GB in all). Send this one next time."],
    // The member's daily quotas (#60).
    ["too_many_today", "That's the most we can take from you in one day. Please send this one tomorrow."],
    ["too_much_today", "That's as much as we can take from you in one day. Please send this one tomorrow."],
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
    await nextAndSend(user);
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

    await user.click(nextButton());
    await user.dblClick(sendButton());

    expect(starts).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe("changing any single one (step 3, optional)", () => {
  /** Through Step 2 with the required answers (and `extra`, there), to Step 3. */
  async function toStep3(sender: Sender, files: File[], extra?: (user: User) => Promise<void>) {
    const user = userEvent.setup();
    render(<App boot={boot} sender={sender} />);
    await pick(user, files);
    await user.click(nextButton());
    await fillRequired(user);
    await extra?.(user);
    await user.click(nextButton());
    return user;
  }

  // Hidden too: while the dialog is open, the page behind it is hidden from screen readers.
  const tile = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^Change details for ${name.replace(".", "\\.")}( \\(Changed\\))?$`), hidden: true });
  const dialog = () => screen.getByRole("dialog");
  const inDialog = () => within(dialog());

  async function open(user: User, name: string) {
    await user.click(tile(name));
    return dialog();
  }

  it("says the step is optional, shows the same gallery to tap, and sends nothing until Send", async () => {
    const { sender, starts } = fakeSender();
    await toStep3(sender, [photo("a.jpg"), video("b.mov")]);

    expect(screen.getByText("Step 3 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toHaveFocus();
    expect(screen.getByText(/^Everything will use the details you just entered\./)).toHaveTextContent(
      "Everything will use the details you just entered. This step is optional. If a photo or video needs something different, tap it to change it. Otherwise just press Send.",
    );
    const gallery = screen.getByRole("list", { name: "Your photos and videos" });
    expect(within(gallery).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Change details for a.jpg",
      "Change details for b.mov",
    ]);
    // Taking one out is in the dialog here, not on the tile.
    expect(screen.queryByRole("button", { name: /^Take .* out$/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Changed")).not.toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    expect(starts).toHaveLength(0);
  });

  it("opens one in a dialog prefilled with the Step 2 answers, and no rights question", async () => {
    const { sender } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg")], async (u) => {
      await u.click(screen.getByRole("checkbox", { name: "Work in Progress" }));
      await u.type(screen.getByLabelText(/When were they taken\?/), "2026-05-03");
      await choose(u, /Where were they taken\?/, "Shop");
      await u.type(screen.getByRole("textbox", { name: "Anything else we should know?" }), "Day one");
    });

    const d = await open(user, "b.jpg");

    expect(d).toHaveAccessibleName("Change details for b.jpg");
    expect(d).toHaveAccessibleDescription("Leave a box empty to use what you entered in the last step.");
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).toHaveValue("Dovetail class, May 3");
    expect(inDialog().getByRole("button", { name: /What was the occasion\?/ })).toHaveTextContent("Classes & Workshops");
    const subjects = inDialog().getByRole("group", { name: /What's in them\?/ });
    expect(within(subjects).getByRole("checkbox", { name: "Finished Piece" })).toBeChecked();
    expect(within(subjects).getByRole("checkbox", { name: "Work in Progress" })).toBeChecked();
    expect(within(subjects).getByRole("checkbox", { name: "Tool or Equipment" })).not.toBeChecked();
    expect(inDialog().getByLabelText(/When were they taken\?/)).toHaveValue("2026-05-03");
    expect(inDialog().getByRole("button", { name: /Where were they taken\?/ })).toHaveTextContent("Shop");
    expect(inDialog().getByRole("textbox", { name: "Anything else we should know?" })).toHaveValue("Day one");
    // Nothing is required for a single one: an empty box uses Step 2's answer.
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).not.toBeRequired();
    expect(inDialog().queryByText(/For example/)).not.toBeInTheDocument();
    // The rights confirmation is for everything, once.
    expect(inDialog().queryByRole("checkbox", { name: /permission to share/ })).not.toBeInTheDocument();
    expect(inDialog().getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(inDialog().getByRole("button", { name: "Remove this one" })).toBeInTheDocument();
  });

  it("keeps a change, marks that one Changed, and sends it for that one only", async () => {
    const { sender, starts, calls } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);

    await open(user, "b.jpg");
    const title = inDialog().getByRole("textbox", { name: "What are these?" });
    await user.clear(title);
    await user.type(title, "My jack plane");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tile("b.jpg")).toHaveAccessibleName("Change details for b.jpg (Changed)");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    expect(within(tile("b.jpg").closest("li")!).getByText(/Changed/)).toBeInTheDocument();
    expect(screen.getAllByText(/Changed/)).toHaveLength(1);

    // Opened again, it shows the change.
    await open(user, "b.jpg");
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).toHaveValue("My jack plane");
    await user.keyboard("{Escape}");

    await user.click(sendButton());
    await act(async () => {});

    const key = calls.find((c) => c.file.name === "b.jpg")!.item;
    expect(starts[0]!.items).toEqual({ [key]: { title: "My jack plane" } });
    expect(starts[0]!.details.title).toBe("Dovetail class, May 3");
    // Every one names its own key, so the service knows whose answers are whose.
    expect(new Set(calls.map((c) => c.item)).size).toBe(calls.length);
  });

  it("goes back to the Step 2 answer when a box is emptied, and the badge goes with it", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg")]);

    await open(user, "a.jpg");
    const caption = inDialog().getByRole("textbox", { name: "Anything else we should know?" });
    await user.type(caption, "Only this one");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg (Changed)");
    await user.clear(caption);
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    const title = inDialog().getByRole("textbox", { name: "What are these?" });
    await user.clear(title);
    // An emptied box stays empty while it is being edited...
    expect(title).toHaveValue("");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    // ...and shows the Step 2 answer next time.
    await open(user, "a.jpg");
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).toHaveValue("Dovetail class, May 3");
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/Changed/)).not.toBeInTheDocument();

    await user.click(sendButton());
    expect(starts[0]).not.toHaveProperty("items");
  });

  it("drops the badge when a change is put back to the Step 2 answer", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg")]);

    await open(user, "a.jpg");
    await choose(user, /What was the occasion\?/, "Toy Drive");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg (Changed)");
    await choose(user, /What was the occasion\?/, "Classes & Workshops");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(sendButton());
    expect(starts[0]).not.toHaveProperty("items");
  });

  it("cannot blank an optional answer Step 2 filled in", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg")], async (u) => {
      await u.type(screen.getByLabelText(/When were they taken\?/), "2026-05-03");
      await choose(u, /Where were they taken\?/, "Shop");
    });

    await open(user, "a.jpg");
    // The place has no way to be emptied here...
    await user.click(inDialog().getByRole("button", { name: /Where were they taken\?/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(OPTIONS.location);
    await user.keyboard("{Escape}");
    // ...and an emptied date is Step 2's date.
    await user.clear(inDialog().getByLabelText(/When were they taken\?/));
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    await open(user, "a.jpg");
    expect(inDialog().getByLabelText(/When were they taken\?/)).toHaveValue("2026-05-03");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(sendButton());
    expect(starts[0]).not.toHaveProperty("items");
    expect(starts[0]!.details).toMatchObject({ date: "2026-05-03", location: "Shop" });
  });

  it("lets one have a place Step 2 left empty, and empty it again", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg")]);

    await open(user, "a.jpg");
    await choose(user, /Where were they taken\?/, "Swap Meet");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg (Changed)");
    await choose(user, /Where were they taken\?/, "Leave empty");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(sendButton());
    expect(starts[0]).not.toHaveProperty("items");
  });

  it("changes what's in one (Subject Type), many at once, leaving the others as Step 2 said", async () => {
    const { sender, starts, calls } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg")]);

    await open(user, "a.jpg");
    const subjects = within(inDialog().getByRole("group", { name: /What's in them\?/ }));
    await user.click(subjects.getByRole("checkbox", { name: "Finished Piece" }));
    // None ticked is Step 2's answer: not changed.
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await user.click(subjects.getByRole("checkbox", { name: "Tool or Equipment" }));
    await user.click(subjects.getByRole("checkbox", { name: "Work in Progress" }));
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg (Changed)");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await open(user, "b.jpg");
    expect(within(inDialog().getByRole("group", { name: /What's in them\?/ })).getByRole("checkbox", { name: "Finished Piece" })).toBeChecked();
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(sendButton());
    await act(async () => {});
    const key = calls.find((c) => c.file.name === "a.jpg")!.item;
    expect(Object.keys(starts[0]!.items!)).toEqual([key]);
    expect([...starts[0]!.items![key]!.subjecttype!].sort()).toEqual(["Tool or Equipment", "Work in Progress"]);
    expect(starts[0]!.details.subjecttype).toEqual(["Finished Piece"]);
  });

  it("takes one out with Remove this one, moving focus to the next", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);
    await open(user, "b.jpg");
    await user.type(inDialog().getByRole("textbox", { name: "Anything else we should know?" }), "Gone soon");

    await user.click(inDialog().getByRole("button", { name: "Remove this one" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /b\.jpg/ })).not.toBeInTheDocument();
    await waitFor(() => expect(tile("c.jpg")).toHaveFocus());
    await user.click(sendButton());
    expect(starts[0]).toMatchObject({ expectedItems: 2 });
    expect(starts[0]).not.toHaveProperty("items");
  });

  it("goes back to choosing when the last one is removed", async () => {
    const { sender } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg")]);
    await open(user, "a.jpg");

    await user.click(inDialog().getByRole("button", { name: "Remove this one" }));

    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toHaveFocus();
  });

  it("works by keyboard alone: Enter opens, focus is in the dialog, Escape keeps the change and returns to the tile", async () => {
    const { sender } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg")]);

    // From the heading: the first tile, then the second.
    await user.tab();
    expect(tile("a.jpg")).toHaveFocus();
    await user.tab();
    expect(tile("b.jpg")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);

    await user.click(inDialog().getByRole("textbox", { name: "Name of the class or event, if there is one" }));
    await user.keyboard("Hand tools");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(tile("b.jpg")).toHaveFocus());
    expect(tile("b.jpg")).toHaveAccessibleName("Change details for b.jpg (Changed)");
    await user.keyboard(" ");
    expect(inDialog().getByRole("textbox", { name: "Name of the class or event, if there is one" })).toHaveValue("Hand tools");
  });

  it("asks again for one's own choice taken off the club's list since the page loaded, naming it", async () => {
    const now = { ...OPTIONS, location: ["Shop"] };
    const beginResults: BeginResult[] = [];
    const { sender, starts } = fakeSender({ beginResults });
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg")]);
    await open(user, "b.jpg");
    await choose(user, /Where were they taken\?/, "Swap Meet");
    await user.type(inDialog().getByRole("textbox", { name: "Anything else we should know?" }), "Busy day");
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    // The service names b.jpg back by the key the page gave it.
    const key = tile("b.jpg").closest("li")!.getAttribute("data-key")!;
    beginResults.push({ ok: false, reason: "invalid", problems: [{ item: key, field: "location", problem: "not_offered" }], options: now });

    await user.click(sendButton());

    expect(starts[0]!.items![key]).toEqual({ location: "Swap Meet", caption: "Busy day" });
    expect(screen.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A choice you made for b.jpg is no longer on the list. Tap it to choose again, or press Send to use what you entered in the last step.",
    );
    await open(user, "b.jpg");
    expect(inDialog().getByText("That choice is no longer on the list. Please choose again.")).toBeInTheDocument();
    // The rest of what was changed is kept.
    expect(inDialog().getByRole("textbox", { name: "Anything else we should know?" })).toHaveValue("Busy day");
    await user.click(inDialog().getByRole("button", { name: /Where were they taken\?/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Shop"]);
    await user.click(screen.getByRole("option", { name: "Shop" }));
    expect(inDialog().queryByText("That choice is no longer on the list. Please choose again.")).not.toBeInTheDocument();
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(sendButton());
    expect(starts).toHaveLength(2);
    expect(starts[1]!.items![key]).toEqual({ location: "Shop", caption: "Busy day" });
    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
  });

  const backButton = () => screen.getByRole("button", { name: "Back" });
  const captionBox = () => screen.getByRole("textbox", { name: "Anything else we should know?" });

  it("goes Back to Step 2 keeping every answer, with focus on its heading, and returns with the changes still marked", async () => {
    const { sender, starts, calls } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg")], async (u) => {
      await choose(u, /Where were they taken\?/, "Shop");
    });
    await open(user, "b.jpg");
    const title = inDialog().getByRole("textbox", { name: "What are these?" });
    await user.clear(title);
    await user.type(title, "My jack plane");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(backButton());

    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Tell us about them" })).toHaveFocus();
    expect(titleBox()).toHaveValue("Dovetail class, May 3");
    expect(screen.getByRole("button", { name: /What was the occasion\?/ })).toHaveTextContent("Classes & Workshops");
    expect(screen.getByRole("checkbox", { name: "Finished Piece" })).toBeChecked();
    expect(screen.getByRole("button", { name: /Where were they taken\?/ })).toHaveTextContent("Shop");
    expect(rightsBox()).toBeChecked();
    expect(nextButton()).toBeEnabled();
    expect(starts).toHaveLength(0);

    await user.click(nextButton());

    expect(screen.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toHaveFocus();
    expect(tile("b.jpg")).toHaveAccessibleName("Change details for b.jpg (Changed)");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await open(user, "b.jpg");
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).toHaveValue("My jack plane");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(sendButton());
    await act(async () => {});
    const key = calls.find((c) => c.file.name === "b.jpg")!.item;
    expect(starts[0]!.items).toEqual({ [key]: { title: "My jack plane" } });
    expect(starts[0]!).toMatchObject({ rightsConfirmed: true, details: { title: "Dovetail class, May 3", location: "Shop" } });
  });

  it("after Back, one's own changed answer stays its own, and its unchanged ones follow a new Step 2 answer", async () => {
    const { sender, starts, calls } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg"), photo("b.jpg")]);
    await open(user, "b.jpg");
    const title = inDialog().getByRole("textbox", { name: "What are these?" });
    await user.clear(title);
    await user.type(title, "My jack plane");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(backButton());
    await user.clear(titleBox());
    await user.type(titleBox(), "Hand tool class");
    await user.type(captionBox(), "Second day");
    await user.click(nextButton());

    expect(tile("b.jpg")).toHaveAccessibleName("Change details for b.jpg (Changed)");
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await open(user, "b.jpg");
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).toHaveValue("My jack plane");
    expect(inDialog().getByRole("textbox", { name: "Anything else we should know?" })).toHaveValue("Second day");
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    await open(user, "a.jpg");
    expect(inDialog().getByRole("textbox", { name: "What are these?" })).toHaveValue("Hand tool class");
    await user.click(inDialog().getByRole("button", { name: "Done" }));

    await user.click(sendButton());
    await act(async () => {});
    const key = calls.find((c) => c.file.name === "b.jpg")!.item;
    expect(starts[0]!.details).toMatchObject({ title: "Hand tool class", caption: "Second day" });
    expect(starts[0]!.items).toEqual({ [key]: { title: "My jack plane" } });
  });

  it("a box typed back to the Step 2 answer is not Changed, so after Back it follows a new Step 2 answer", async () => {
    const { sender, starts } = fakeSender();
    const user = await toStep3(sender, [photo("a.jpg")], async (u) => {
      await u.type(captionBox(), "Day one");
    });
    await open(user, "a.jpg");
    const caption = inDialog().getByRole("textbox", { name: "Anything else we should know?" });
    await user.clear(caption);
    await user.type(caption, "Day one");
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");

    await user.click(backButton());
    await user.clear(captionBox());
    await user.type(captionBox(), "Day two");
    await user.click(nextButton());

    expect(tile("a.jpg")).toHaveAccessibleName("Change details for a.jpg");
    await open(user, "a.jpg");
    expect(inDialog().getByRole("textbox", { name: "Anything else we should know?" })).toHaveValue("Day two");
    await user.click(inDialog().getByRole("button", { name: "Done" }));
    await user.click(sendButton());
    expect(starts[0]).not.toHaveProperty("items");
    expect(starts[0]!.details.caption).toBe("Day two");
  });
});

/** Only the page's own pauses run on the test's clock. */
const CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout"] };

/**
 * Presses a button while the test moves the clock: the press itself needs
 * real timers. Only when no pause of the page's is running, as switching
 * clocks drops it.
 */
async function press(button: HTMLElement) {
  vi.useRealTimers();
  await userEvent.setup().click(button);
  vi.useFakeTimers(CLOCK);
}

describe("when things go wrong (#58)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const statusOf = (name: string) => within(screen.getByText(name).closest("li")!).getByRole("status");
  const tryAgainIn = (name: string) => within(screen.getByText(name).closest("li")!).queryByRole("button", { name: "Try again" });

  /** Chooses these, describes and sends them, then lets the test move the clock. */
  async function sendingWithClock(files: File[]) {
    const user = userEvent.setup();
    const fake = fakeSender();
    render(<App boot={boot} sender={fake.sender} />);
    await pick(user, files);
    await describeAndSend(user);
    vi.useFakeTimers(CLOCK);
    return fake;
  }

  const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
  /** The last send of this file. */
  const lastCall = (calls: Call[], name: string) => calls.filter((c) => c.file.name === name).at(-1)!;

  it("shows Connection trouble and tries again by itself, resuming the same file in the same Submission", async () => {
    const { calls, starts } = await sendingWithClock([photo("a.jpg")]);
    act(() => calls[0]!.events.onProgress(40));

    await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));

    expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");
    // Nothing for the member to do while it tries by itself.
    expect(tryAgainIn("a.jpg")).not.toBeInTheDocument();
    await wait(999);
    expect(calls).toHaveLength(1);
    await wait(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.file).toBe(calls[0]!.file);
    expect(calls[1]!.submission).toBe(1);
    expect(starts).toHaveLength(1);
    // Still Connection trouble until the service answers.
    expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");

    act(() => calls[1]!.events.onProgress(60));
    expect(statusOf("a.jpg")).toHaveTextContent("Sending…");
    expect(screen.getByRole("progressbar", { name: "a.jpg" })).toHaveAttribute("aria-valuenow", "60");
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
  });

  it("tries again at about 1, 3, 10, 30 and 60 seconds, then every minute for about 10 minutes, then waits for the member", async () => {
    const { calls } = await sendingWithClock([photo("a.jpg")]);
    const schedule = [1, 3, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60];

    await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
    for (const [i, seconds] of schedule.entries()) {
      await wait(seconds * 1000 - 1);
      expect(calls, `try ${i + 1} not before ${seconds} s`).toHaveLength(i + 1);
      await wait(1);
      expect(calls, `try ${i + 1} after ${seconds} s`).toHaveLength(i + 2);
      expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");
      await act(async () => calls.at(-1)!.finish({ ok: false, reason: "connection" }));
    }

    expect(statusOf("a.jpg")).toHaveTextContent("Waiting for your connection");
    await wait(10 * 60 * 1000);
    expect(calls).toHaveLength(schedule.length + 1);

    await press(tryAgainIn("a.jpg")!);
    expect(calls).toHaveLength(schedule.length + 2);
    // Try again starts the schedule over.
    await act(async () => calls.at(-1)!.finish({ ok: false, reason: "connection" }));
    expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");
    await wait(1000);
    expect(calls).toHaveLength(schedule.length + 3);
  });

  it("starts the schedule over once the service answers again", async () => {
    const { calls } = await sendingWithClock([video("c.mov")]);

    await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
    await wait(1000);
    await act(async () => calls[1]!.finish({ ok: false, reason: "connection" }));
    await wait(3000);
    expect(calls).toHaveLength(3);
    // The file is all there; the service says it is handing it over.
    act(() => calls[2]!.events.onFinishing());
    expect(statusOf("c.mov")).toHaveTextContent("Finishing up… (videos can take a few minutes)");
    await act(async () => calls[2]!.finish({ ok: false, reason: "connection" }));

    await wait(1000);
    expect(calls).toHaveLength(4);
  });

  it("keeps the rest going while one has Connection trouble", async () => {
    const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg"]);

    await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));

    // Its place goes to the next one while it pauses.
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    // Its try waits for a free place: two at a time still.
    await wait(1000);
    expect(calls).toHaveLength(3);
    expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg", "a.jpg"]);
  });

  it("keeps the rest going while one Couldn't save, and offers Try again for it", async () => {
    const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);

    await act(async () => calls[0]!.finish({ ok: false, reason: "failed" }));

    expect(statusOf("a.jpg")).toHaveTextContent("Couldn't save this one");
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    // Never by itself: only the member's Try again, while the page is open.
    await wait(60 * 60 * 1000);
    expect(calls).toHaveLength(3);
    await press(tryAgainIn("a.jpg")!);
    // Waiting for a free place: two at a time still.
    expect(statusOf("a.jpg")).toHaveTextContent("Waiting…");
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(calls).toHaveLength(4);
    expect(lastCall(calls, "a.jpg").file).toBe(calls[0]!.file);
  });

  it("announces Connection trouble and Waiting for your connection to screen readers", async () => {
    const { calls } = await sendingWithClock([photo("a.jpg")]);
    const status = screen.getByRole("status");

    await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
    expect(status).toHaveTextContent("Connection dropped. Trying again…");
    for (const seconds of [1, 3, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]) {
      await wait(seconds * 1000);
      await act(async () => calls.at(-1)!.finish({ ok: false, reason: "connection" }));
    }
    expect(status).toHaveTextContent("Waiting for your connection");
  });
});

describe("the end when some were not sent (#58)", () => {
  it("says most are in, lists the ones not sent, and Try again sends just those", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), photo("b.jpg"), video("c.mov")]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: true }));
    await act(async () => calls[1]!.finish({ ok: false, reason: "failed" }));
    await act(async () => calls[2]!.finish({ ok: true }));

    const heading = screen.getByRole("heading", { name: "Most of your photos are in." });
    expect(heading).toHaveFocus();
    expect(
      screen.getByText("1 of 3 didn't make it. Try those again now, or come back later and choose them again."),
    ).toBeInTheDocument();
    expect(screen.getByText("b.jpg")).toBeInTheDocument();
    expect(screen.queryByText("a.jpg")).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't save this one")).toBeInTheDocument();
    expect(screen.queryByText(/^Thank you!/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toHaveFocus();
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.mov", "b.jpg"]);
    expect(screen.getByText("2 of 3 sent.")).toBeInTheDocument();
    await act(async () => calls[3]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 2 photos and 1 video." })).toBeInTheDocument();
  });

  it("lists one still waiting for the connection, and its way out keeps what was sent", async () => {
    try {
      const user = userEvent.setup();
      const { sender, calls } = fakeSender();
      render(<App boot={boot} sender={sender} />);
      await pick(user, [photo("a.jpg"), photo("b.jpg")]);
      await describeAndSend(user);
      vi.useFakeTimers(CLOCK);

      await act(async () => calls[0]!.finish({ ok: true }));
      await act(async () => calls[1]!.finish({ ok: false, reason: "connection" }));
      // Not the end while it still tries by itself.
      expect(screen.queryByRole("heading", { name: "Most of your photos are in." })).not.toBeInTheDocument();
      for (const seconds of [1, 3, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]) {
        await act(async () => vi.advanceTimersByTime(seconds * 1000));
        await act(async () => calls.at(-1)!.finish({ ok: false, reason: "connection" }));
      }

      expect(screen.getByRole("heading", { name: "Most of your photos are in." })).toHaveFocus();
      expect(screen.getByText(/^1 of 2 didn't make it\./)).toBeInTheDocument();
      expect(screen.getByText("Waiting for your connection")).toBeInTheDocument();

      await press(screen.getByRole("button", { name: "I'll do the rest later" }));

      expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toHaveFocus();
      expect(screen.getByText("A volunteer will take a look before they appear on the SDFWA media site.")).toBeInTheDocument();
      expect(
        screen.getByText("The ones that didn't go through weren't sent. You can share them again any time."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/You don't need to do anything else/)).not.toBeInTheDocument();
      const sends = calls.length;
      await act(async () => vi.advanceTimersByTime(60 * 60 * 1000));
      expect(calls).toHaveLength(sends);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays on Sending, each with its Try again, when none was sent", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), photo("b.jpg")]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: false, reason: "failed" }));
    await act(async () => calls[1]!.finish({ ok: false, reason: "failed" }));

    expect(screen.getByRole("heading", { level: 2, name: "Sending" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
  });

  it("lists one that can't be added with its reason, and Try again is only for the others", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: true }));
    await act(async () => calls[1]!.finish({ ok: false, reason: "too_many_today" }));
    await act(async () => calls[2]!.finish({ ok: false, reason: "failed" }));

    expect(screen.getByRole("heading", { name: "Most of your photos are in." })).toHaveFocus();
    expect(screen.getByText(/^2 of 3 didn't make it\./)).toBeInTheDocument();
    expect(screen.getByText(/^Can't be added:/)).toHaveTextContent(
      "Can't be added: That's the most we can take from you in one day. Please send this one tomorrow.",
    );
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    // Only the one that couldn't be saved is sent again.
    expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg", "c.jpg"]);
    await act(async () => calls[3]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Most of your photos are in." })).toBeInTheDocument();
    expect(screen.getByText(/^1 of 3 didn't make it\./)).toBeInTheDocument();
  });

  it("offers no Try again when the only ones not sent can't be added", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg"), video("b.mov")]);
    await describeAndSend(user);

    await act(async () => calls[0]!.finish({ ok: true }));
    await act(async () => calls[1]!.finish({ ok: false, reason: "too_many_videos" }));

    expect(screen.getByRole("heading", { name: "Most of your photos are in." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I'll do the rest later" }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
  });
});

describe("phone and sign-in interruptions (#59)", () => {
  let online = true;
  let visibility: DocumentVisibilityState = "visible";
  /** Each wake lock the page asked for, in turn. */
  let locks: { released: boolean; release: () => Promise<void> }[] = [];
  let wakeLockRequests = 0;

  beforeEach(() => {
    online = true;
    visibility = "visible";
    locks = [];
    wakeLockRequests = 0;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          wakeLockRequests++;
          const lock = {
            released: false,
            release: async () => {
              lock.released = true;
            },
          };
          locks.push(lock);
          return lock;
        },
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    // Back to jsdom's own.
    delete (navigator as { onLine?: boolean }).onLine;
    delete (document as { visibilityState?: string }).visibilityState;
    delete (navigator as { wakeLock?: unknown }).wakeLock;
  });

  const statusOf = (name: string) => within(screen.getByText(name).closest("li")!).getByRole("status");
  const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
  const fire = (target: EventTarget, type: string) => act(async () => void target.dispatchEvent(new Event(type)));
  const goOffline = () => {
    online = false;
    return fire(window, "offline");
  };
  const goOnline = () => {
    online = true;
    return fire(window, "online");
  };
  /** The phone puts the page away, then shows it again. */
  const hide = () => {
    visibility = "hidden";
    // The browser lets go of the wake lock whenever the page is hidden.
    for (const lock of locks) lock.released = true;
    return fire(document, "visibilitychange");
  };
  const show = () => {
    visibility = "visible";
    return fire(document, "visibilitychange");
  };
  /** Whether leaving the page now would ask first. */
  const leaveWarns = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const heldLocks = () => locks.filter((l) => !l.released).length;

  async function sendingWithClock(files: File[], opts: Parameters<typeof fakeSender>[0] = {}) {
    const user = userEvent.setup();
    const fake = fakeSender(opts);
    render(<App boot={boot} sender={fake.sender} />);
    await pick(user, files);
    await describeAndSend(user);
    vi.useFakeTimers(CLOCK);
    return fake;
  }

  describe("offline", () => {
    it("holds everything with the banner, and carries on at once when the connection is back", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg"), photo("c.jpg"), photo("d.jpg")]);
      // a.jpg pauses before its next try; c.jpg takes its place.
      await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);

      await goOffline();

      expect(screen.getByText("No internet connection. Your photos will keep going when it comes back.")).toBeInTheDocument();
      // The ones in flight end as they will; nothing starts in their place, and no automatic try runs.
      await act(async () => calls[1]!.finish({ ok: true }));
      await act(async () => calls[2]!.finish({ ok: false, reason: "connection" }));
      await wait(15 * 60 * 1000);
      expect(calls).toHaveLength(3);
      expect(statusOf("d.jpg")).toHaveTextContent("Waiting…");
      expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");

      await goOnline();

      expect(screen.queryByText(/No internet connection/)).not.toBeInTheDocument();
      // Straight away, without waiting out the schedule: the two paused tries first, then d.jpg's turn.
      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg", "a.jpg", "c.jpg"]);
      expect(calls[3]!.file).toBe(calls[0]!.file);
      expect(calls[3]!.submission).toBe(1);
      await act(async () => calls[3]!.finish({ ok: true }));
      expect(calls.at(-1)!.file.name).toBe("d.jpg");
    });

    it("does not take 'online' as proof: a try that fails goes on along the schedule", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg")]);
      await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
      await goOffline();
      await goOnline();
      expect(calls).toHaveLength(2);

      await act(async () => calls[1]!.finish({ ok: false, reason: "connection" }));

      expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");
      await wait(2999);
      expect(calls).toHaveLength(2);
      await wait(1);
      expect(calls).toHaveLength(3);
    });

    it("starts nothing when Send is pressed with no connection, until it is back", async () => {
      const user = userEvent.setup();
      const { sender, calls } = fakeSender();
      render(<App boot={boot} sender={sender} />);
      await pick(user, [photo("a.jpg")]);
      await user.click(nextButton());
      await fillRequired(user);
      await user.click(nextButton());
      online = false;
      await user.click(sendButton());
      await act(async () => {});

      expect(screen.getByText("No internet connection. Your photos will keep going when it comes back.")).toBeInTheDocument();
      expect(calls).toHaveLength(0);

      await goOnline();

      expect(calls).toHaveLength(1);
    });
  });

  describe("the foreground", () => {
    it("tries again at once when the page is shown again, even one waiting for the connection", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg")]);
      await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
      await act(async () => calls[1]!.finish({ ok: false, reason: "connection" }));

      await hide();
      await show();

      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "a.jpg", "b.jpg"]);

      // Waiting for your connection: one more try when the member comes back to the page.
      for (const seconds of [3, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]) {
        await act(async () => calls.at(-2)!.finish({ ok: false, reason: "connection" }));
        await act(async () => calls.at(-1)!.finish({ ok: false, reason: "connection" }));
        await wait(seconds * 1000);
      }
      await act(async () => calls.at(-2)!.finish({ ok: false, reason: "connection" }));
      await act(async () => calls.at(-1)!.finish({ ok: false, reason: "connection" }));
      expect(statusOf("a.jpg")).toHaveTextContent("Waiting for your connection");
      const before = calls.length;

      await hide();
      await show();

      expect(calls).toHaveLength(before + 2);
      await act(async () => calls.at(-2)!.finish({ ok: true }));
      await act(async () => calls.at(-1)!.finish({ ok: true }));
      expect(screen.getByRole("heading", { name: "Thank you! We have your 2 photos." })).toBeInTheDocument();
    });
  });

  describe("the screen wake lock", () => {
    it("keeps the screen awake while sending, asks again when the page is shown, and lets go at the thank-you", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg")]);
      expect(screen.getByText("Please keep this page open and your phone awake until it says thank you.")).toBeInTheDocument();
      expect(wakeLockRequests).toBe(1);
      expect(heldLocks()).toBe(1);

      await hide();
      expect(heldLocks()).toBe(0);
      await show();
      expect(wakeLockRequests).toBe(2);
      expect(heldLocks()).toBe(1);

      await act(async () => calls[0]!.finish({ ok: true }));

      expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
      expect(heldLocks()).toBe(0);
      // Done means done: nothing more is asked for, or tried.
      await show();
      await goOffline();
      await goOnline();
      await fire(window, "focus");
      expect(wakeLockRequests).toBe(2);
      expect(calls).toHaveLength(1);
      expect(leaveWarns()).toBe(false);
    });

    it("is not asked for before Send", async () => {
      const user = userEvent.setup();
      render(<App boot={boot} sender={fakeSender().sender} />);
      await pick(user, [photo("a.jpg")]);

      expect(wakeLockRequests).toBe(0);
    });

    it("sends all the same where the browser has none, or refuses it", async () => {
      delete (navigator as { wakeLock?: unknown }).wakeLock;
      const { calls } = await sendingWithClock([photo("a.jpg")]);
      await act(async () => calls[0]!.finish({ ok: true }));
      expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
      cleanup();

      vi.useRealTimers();
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: { request: () => Promise.reject(new DOMException("Low battery", "NotAllowedError")) },
      });
      const second = await sendingWithClock([photo("b.jpg")]);
      await act(async () => second.calls[0]!.finish({ ok: true }));
      expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
    });
  });

  describe("leaving the page", () => {
    it("asks first only while something is still on its way", async () => {
      const user = userEvent.setup();
      const { sender, calls } = fakeSender();
      render(<App boot={boot} sender={sender} />);
      await pick(user, [photo("a.jpg"), photo("b.jpg")]);
      expect(leaveWarns()).toBe(false);
      await describeAndSend(user);

      expect(leaveWarns()).toBe(true);
      await act(async () => calls[0]!.finish({ ok: true }));
      expect(leaveWarns()).toBe(true);
      await act(async () => calls[1]!.finish({ ok: false, reason: "failed" }));

      expect(screen.getByRole("heading", { name: "Most of your photos are in." })).toBeInTheDocument();
      expect(leaveWarns()).toBe(false);
    });
  });

  describe("signed out", () => {
    it("holds everything, offers sign-in in a new tab, and carries on when the member comes back signed in", async () => {
      let session: SessionCheck = "signed_out";
      const sessionChecks = vi.fn(async () => session);
      const { calls, starts } = await sendingWithClock([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")], {
        session: sessionChecks,
      });
      act(() => calls[0]!.events.onProgress(40));

      await act(async () => calls[0]!.finish({ ok: false, reason: "signed_out" }));

      expect(
        screen.getByText("You've been signed out. Sign in again to keep going. We'll open it in a new tab so your photos stay here."),
      ).toBeInTheDocument();
      const signIn = screen.getByRole("link", { name: "Sign in again" });
      expect(signIn).toHaveAttribute("href", "/upload/signed-in");
      expect(signIn).toHaveAttribute("target", "_blank");
      expect(statusOf("a.jpg")).toHaveTextContent("Waiting…");
      // The one in flight ends as it will; nothing starts while signed out.
      await act(async () => calls[1]!.finish({ ok: false, reason: "signed_out" }));
      await wait(15 * 60 * 1000);
      expect(calls).toHaveLength(2);
      expect(leaveWarns()).toBe(true);

      // Back to this tab before signing in: still signed out.
      await fire(window, "focus");
      expect(sessionChecks).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("link", { name: "Sign in again" })).toBeInTheDocument();

      // Signed in in the other tab, then back to this one.
      session = "signed_in";
      await hide();
      await show();

      expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
      // The same files, in the same Submission: each picks up where it stopped.
      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "a.jpg", "b.jpg"]);
      expect(calls[2]!.file).toBe(calls[0]!.file);
      expect(calls[2]!.submission).toBe(1);
      expect(starts).toHaveLength(1);
      for (const call of calls.slice(2)) await act(async () => call.finish({ ok: true }));
      await act(async () => calls[4]!.finish({ ok: true }));
      expect(screen.getByRole("heading", { name: "Thank you! We have your 3 photos." })).toBeInTheDocument();
    });

    it("holds the automatic tries too, and resumes them when signed in again", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg")]);
      await act(async () => calls[0]!.finish({ ok: false, reason: "connection" }));
      await act(async () => calls[1]!.finish({ ok: false, reason: "signed_out" }));

      await wait(60 * 1000);
      expect(calls).toHaveLength(2);
      expect(statusOf("a.jpg")).toHaveTextContent("Connection dropped. Trying again…");

      await fire(window, "focus");

      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "a.jpg", "b.jpg"]);
    });

    it("keeps everything chosen and entered when Send finds the member signed out", async () => {
      const user = userEvent.setup();
      const { sender, calls, starts } = fakeSender({ beginResults: [{ ok: false, reason: "signed_out" }] });
      render(<App boot={boot} sender={sender} />);
      await pick(user, [photo("a.jpg")]);
      await user.click(nextButton());
      await fillRequired(user);
      await nextAndSend(user);

      expect(screen.getByRole("link", { name: "Sign in again" })).toBeInTheDocument();
      expect(screen.queryByText("We couldn't start sending. Please try again.")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toBeInTheDocument();

      await fire(window, "focus");
      expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
      await user.click(sendButton());
      await act(async () => {});

      expect(starts).toHaveLength(2);
      expect(starts[1]!.details.title).toBe("Dovetail class, May 3");
      expect(calls).toHaveLength(1);
    });
  });

  describe("no longer a member", () => {
    it("shows the renewal message, opening each way out in a new tab, and carries on once that is sorted", async () => {
      let session: SessionCheck = "not_member";
      const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg")], { session: async () => session });
      await act(async () => calls[0]!.finish({ ok: true }));

      await act(async () => calls[1]!.finish({ ok: false, reason: "not_member" }));

      expect(screen.getByText("This page is for current SDFWA members")).toBeInTheDocument();
      expect(
        screen.getByText("You're signed in as Pat Member, but we don't see a current paid membership on this account."),
      ).toBeInTheDocument();
      const renew = screen.getByRole("link", { name: "Renew my membership" });
      expect(renew).toHaveAttribute("href", "https://www.example.org/renew");
      expect(renew).toHaveAttribute("target", "_blank");
      const other = screen.getByRole("link", { name: "Sign out and sign in again" });
      expect(other).toHaveAttribute("href", "https://auth.example.org/logout?redirect=signed-in");
      expect(other).toHaveAttribute("target", "_blank");
      // What was sent stays sent.
      expect(statusOf("a.jpg")).toHaveTextContent("✓ Sent");

      await fire(window, "focus");
      expect(calls).toHaveLength(2);

      session = "signed_in";
      await fire(window, "focus");

      expect(screen.queryByText("This page is for current SDFWA members")).not.toBeInTheDocument();
      expect(calls).toHaveLength(3);
      expect(calls[2]!.file).toBe(calls[1]!.file);
    });
  });

  describe("a busy service", () => {
    it("says it will keep trying, holds the rest of the queue, and carries on when it can", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);

      await act(async () => calls[0]!.finish({ ok: false, reason: "busy" }));

      expect(screen.getByText("We're busy right now. We'll keep trying for a few minutes.")).toBeInTheDocument();
      expect(screen.queryByText("We're busy right now. Please try again in a few minutes.")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      // b.jpg goes on; c.jpg waits with the queue.
      await act(async () => calls[1]!.finish({ ok: true }));
      expect(calls).toHaveLength(2);
      expect(statusOf("c.jpg")).toHaveTextContent("Waiting…");

      await wait(1000);
      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "a.jpg"]);
      act(() => calls[2]!.events.onProgress(10));

      expect(screen.queryByText(/We'll keep trying/)).not.toBeInTheDocument();
      expect(calls.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg", "a.jpg", "c.jpg"]);
    });

    it("asks the member to try again once the automatic tries run out", async () => {
      const { calls } = await sendingWithClock([photo("a.jpg")]);
      await act(async () => calls[0]!.finish({ ok: false, reason: "busy" }));
      for (const seconds of [1, 3, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]) {
        await wait(seconds * 1000);
        await act(async () => calls.at(-1)!.finish({ ok: false, reason: "busy" }));
      }

      expect(calls).toHaveLength(16);
      expect(statusOf("a.jpg")).toHaveTextContent("We're busy right now. Please try again in a few minutes.");
      expect(screen.queryByText(/We'll keep trying/)).not.toBeInTheDocument();
      await press(screen.getByRole("button", { name: "Try again" }));
      expect(calls).toHaveLength(17);
    });
  });

  describe("browser history", () => {
    const stepHeading = (name: string) => screen.getByRole("heading", { level: 2, name });

    it("Back goes to the previous step, keeping what was entered, and Forward does not skip ahead", async () => {
      const user = userEvent.setup();
      render(<App boot={boot} sender={fakeSender().sender} />);
      await pick(user, [photo("a.jpg")]);
      await user.click(nextButton());
      await fillRequired(user);
      await user.click(nextButton());
      expect(stepHeading("Change any single one (optional)")).toBeInTheDocument();

      await act(async () => history.back());
      await waitFor(() => expect(stepHeading("Tell us about them")).toBeInTheDocument());
      expect(titleBox()).toHaveValue("Dovetail class, May 3");

      await act(async () => history.back());
      await waitFor(() => expect(stepHeading("Choose your photos and videos")).toBeInTheDocument());
      expect(tiles()).toHaveLength(1);

      await act(async () => history.forward());
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(stepHeading("Choose your photos and videos")).toBeInTheDocument();

      // Next again makes the history match.
      await user.click(nextButton());
      expect(stepHeading("Tell us about them")).toBeInTheDocument();
    });

    it("keeps the page's own Back in step with the browser's", async () => {
      const user = userEvent.setup();
      render(<App boot={boot} sender={fakeSender().sender} />);
      await pick(user, [photo("a.jpg")]);
      await user.click(nextButton());
      await fillRequired(user);
      await user.click(nextButton());
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(stepHeading("Tell us about them")).toBeInTheDocument();

      await act(async () => history.back());
      await waitFor(() => expect(stepHeading("Choose your photos and videos")).toBeInTheDocument());
    });

    it("during sending, leaves the page's first entry behind, so Back would leave the page and the warning asks first", async () => {
      const user = userEvent.setup();
      render(<App boot={boot} sender={fakeSender().sender} />);
      await pick(user, [photo("a.jpg")]);
      await describeAndSend(user);

      await waitFor(() => expect((history.state as { sdfwaStep?: { index: number } }).sdfwaStep?.index).toBe(0));
      expect(stepHeading("Sending")).toBeInTheDocument();
      expect(leaveWarns()).toBe(true);
    });
  });

  it("starts only one Submission when Send is pressed twice in a row", async () => {
    const user = userEvent.setup();
    const { sender, starts } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await pick(user, [photo("a.jpg")]);
    await user.click(nextButton());
    await fillRequired(user);
    await user.click(nextButton());

    await user.dblClick(sendButton());
    await act(async () => {});

    expect(starts).toHaveLength(1);
  });
});

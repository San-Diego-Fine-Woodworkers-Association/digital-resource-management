// Seam 2: the page flow for one photo (#53): choose, Title, rights, Send,
// thank-you, with the service's API faked behind the Sender interface.
import { act, render, screen, within } from "@testing-library/react";
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
  file: File;
  details: SendDetails;
  events: SendEvents;
  finish: (result: SendResult) => void;
}

/** A fake service: each send waits until the test decides how it ends. */
function fakeSender() {
  const calls: Call[] = [];
  const sender: Sender = {
    send: (file, details, events) =>
      new Promise((resolve) => {
        calls.push({ file, details, events, finish: resolve });
      }),
  };
  return { sender, calls };
}

const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "IMG_4821.JPG", { type: "image/jpeg" });

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input;
}

async function chooseAndDescribe(user: ReturnType<typeof userEvent.setup>, title = "Dovetail class, May 3") {
  await user.upload(fileInput(), photo());
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.type(screen.getByRole("textbox", { name: /What are these\?/ }), title);
  await user.click(screen.getByRole("checkbox", { name: /I took these, or I have permission to share them with SDFWA/ }));
}

describe("sending one photo", () => {
  it("goes choose, Title, rights, Send, thank-you", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);

    // Step 1: choose.
    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose photos and videos" })).toBeInTheDocument();
    expect(fileInput()).toHaveAttribute("accept", expect.stringContaining("image/heic"));
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    await user.upload(fileInput(), photo());
    expect(screen.getByText("✓ 1 photo chosen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 2: Title and the rights tick.
    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Tell us about them" })).toHaveFocus();
    expect(screen.getByText("For example: Dovetail class, May 3")).toBeInTheDocument();
    expect(screen.getByText(/means you need to fill this in/)).toBeInTheDocument();
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
    expect(screen.getByRole("progressbar", { name: "Sending…" })).toHaveAttribute("aria-valuenow", "40");
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

  it("keeps Send unavailable until there is a Title and the rights tick, saying what is still needed", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await user.upload(fileInput(), photo());
    await user.click(screen.getByRole("button", { name: "Next" }));

    const send = screen.getByRole("button", { name: "Send them" });
    expect(send).toBeDisabled();
    expect(screen.getByText("Still needed: What are these?, Permission to share")).toBeInTheDocument();

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

  it("marks the required questions", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await user.upload(fileInput(), photo());
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("textbox", { name: /What are these\?/ })).toBeRequired();
  });

  it("sends only once when Send is pressed twice", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await chooseAndDescribe(user);

    const send = screen.getByRole("button", { name: "Send them" });
    await user.dblClick(send);

    expect(calls).toHaveLength(1);
  });

  it("offers Try again when the photo could not be saved, and sends the same photo again", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await chooseAndDescribe(user);
    await user.click(screen.getByRole("button", { name: "Send them" }));

    await act(async () => calls[0]!.finish({ ok: false, reason: "failed" }));
    expect(screen.getByText("Couldn't save this one")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.file).toBe(calls[0]!.file);
    expect(calls[1]!.details).toEqual(calls[0]!.details);
    await act(async () => calls[1]!.finish({ ok: true }));
    expect(screen.getByRole("heading", { name: "Thank you! We have your 1 photo." })).toBeInTheDocument();
  });

  it("explains a file the service will not take, and lets the member start again", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await chooseAndDescribe(user);
    await user.click(screen.getByRole("button", { name: "Send them" }));

    await act(async () => calls[0]!.finish({ ok: false, reason: "not_a_photo" }));
    expect(screen.getByText(/Can't be added:/)).toHaveTextContent(
      "Can't be added: This kind of file can't be added. We can take photos (JPG, PNG, HEIC) and videos (MP4, MOV).",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toBeInTheDocument();
  });

  it("lets the member share another after the thank-you, starting fresh", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await chooseAndDescribe(user);
    await user.click(screen.getByRole("button", { name: "Send them" }));
    await act(async () => calls[0]!.finish({ ok: true }));

    await user.click(screen.getByRole("button", { name: "Share more photos or videos" }));

    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toHaveFocus();
    expect(screen.queryByText(/chosen/)).not.toBeInTheDocument();
  });

  it("announces the state of the photo, not every percent", async () => {
    const user = userEvent.setup();
    const { sender, calls } = fakeSender();
    render(<App boot={boot} sender={sender} />);
    await chooseAndDescribe(user);
    await user.click(screen.getByRole("button", { name: "Send them" }));

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Sending…");
    act(() => calls[0]!.events.onProgress(55));
    expect(status).not.toHaveTextContent("55");
    act(() => calls[0]!.events.onFinishing());
    expect(status).toHaveTextContent("Finishing up…");
  });

  it("never sends anything about who the member is: the service takes that from the sign-in", async () => {
    const user = userEvent.setup();
    const send = vi.fn<Sender["send"]>(() => new Promise(() => {}));
    render(<App boot={boot} sender={{ send }} />);
    await chooseAndDescribe(user);
    await user.click(screen.getByRole("button", { name: "Send them" }));

    const [, details] = send.mock.calls[0]!;
    expect(Object.keys(details).sort()).toEqual(["rightsConfirmed", "title"]);
    expect(JSON.stringify(details)).not.toMatch(/Pat|pat@example/);
  });
});

describe("the chosen photo", () => {
  it("shows a preview, or a plain placeholder when the browser cannot draw it", async () => {
    const user = userEvent.setup();
    render(<App boot={boot} sender={fakeSender().sender} />);
    await user.upload(fileInput(), photo());

    const chosen = screen.getByRole("img", { name: "IMG_4821.JPG" });
    act(() => {
      chosen.dispatchEvent(new Event("error"));
    });
    expect(within(screen.getByRole("main")).getByText("Photo (preview not available)")).toBeInTheDocument();
  });
});

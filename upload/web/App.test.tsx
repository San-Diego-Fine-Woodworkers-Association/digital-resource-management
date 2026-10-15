// Seam 2: the page's screens, driven by what the service says when it serves
// the page (the boot data). The service itself is covered by server/*.test.ts.
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BOOT_ELEMENT_ID, type Boot } from "../shared/boot.ts";
import { App } from "./App.tsx";
import { readBoot } from "./boot.ts";

const user = { name: "Pat Member", email: "pat@example.org" };
const signOutUrl = "https://auth.example.org/logout?redirect=https%3A%2F%2Fmedia.example.org%2Fupload%2F";
const renewUrl = "https://www.example.org/renew";
const switchAccountUrl = "https://auth.example.org/logout?redirect=https%3A%2F%2Fmedia.example.org%2Fupload%2Fsigned-in";

describe("a member or volunteer", () => {
  const boot: Boot = { screen: "app", user, signOutUrl, renewUrl, switchAccountUrl };

  it("sees the app shell: who they are and a way to sign out", () => {
    render(<App boot={boot} />);

    const header = screen.getByRole("banner");
    expect(within(header).getByText("SDFWA Media")).toBeInTheDocument();
    expect(within(header).getByRole("heading", { level: 1, name: "Share your photos and videos" })).toBeInTheDocument();
    expect(header).toHaveTextContent("Signed in as Pat Member. Not you? Sign out");
    expect(within(header).getByRole("link", { name: "Sign out" })).toHaveAttribute("href", signOutUrl);
  });

  it("starts on step 1 of the four-step frame", () => {
    render(<App boot={boot} />);

    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toBeInTheDocument();
    expect(
      screen.getByText("Pick the photos and videos you'd like to share. You can choose many at once."),
    ).toBeInTheDocument();
  });

  it("does not see member-only wording meant for others", () => {
    render(<App boot={boot} />);

    expect(screen.queryByText(/current SDFWA members/)).not.toBeInTheDocument();
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument();
  });
});

describe("someone signed in without a current membership", () => {
  const boot: Boot = { screen: "not-member", user, renewUrl: "https://www.example.org/renew", signOutUrl };

  it("sees the friendly page with the two ways forward", () => {
    render(<App boot={boot} />);

    expect(screen.getByRole("heading", { level: 2, name: "This page is for current SDFWA members" })).toBeInTheDocument();
    expect(screen.getByText(/You're signed in as/)).toHaveTextContent(
      "You're signed in as Pat Member, but we don't see a current paid membership on this account.",
    );
    expect(screen.getByRole("link", { name: "Renew my membership" })).toHaveAttribute("href", "https://www.example.org/renew");
    expect(screen.getByRole("link", { name: "Sign out and sign in again" })).toHaveAttribute("href", signOutUrl);
  });

  it("does not see the upload steps", () => {
    render(<App boot={boot} />);

    expect(screen.queryByText(/Step 1 of 4/)).not.toBeInTheDocument();
  });
});

describe("when the service cannot take photos right now", () => {
  it("shows the plain paused page when uploads are switched off", () => {
    render(<App boot={{ screen: "paused" }} />);

    expect(screen.getByText("Sharing is paused for a little while. Please come back later.")).toBeInTheDocument();
    expect(screen.queryByText(/Step 1 of 4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
  });

  it("shows a temporary problem, not a sign-in prompt, when sign-in can't be checked", () => {
    render(<App boot={{ screen: "unavailable" }} />);

    expect(screen.getByText("We're busy right now. Please try again in a few minutes.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/upload/");
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
  });
});

describe("the new tab after signing in again (#59)", () => {
  it("says the member can close it, and offers nothing to send from it", () => {
    render(<App boot={{ screen: "signed-in" }} />);

    expect(screen.getByText("You're signed in. You can close this tab.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is read from the page", () => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = BOOT_ELEMENT_ID;
    el.textContent = JSON.stringify({ screen: "signed-in" });
    document.head.append(el);

    expect(readBoot(document)).toEqual({ screen: "signed-in" });
    el.remove();
  });
});

describe("reading what the service sent", () => {
  afterEach(() => document.getElementById(BOOT_ELEMENT_ID)?.remove());

  function embed(text: string) {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = BOOT_ELEMENT_ID;
    el.textContent = text;
    document.head.append(el);
  }

  it("reads the screen and user from the page", () => {
    embed(JSON.stringify({ screen: "app", user, signOutUrl, renewUrl, switchAccountUrl }));

    expect(readBoot(document)).toEqual({ screen: "app", user, signOutUrl, renewUrl, switchAccountUrl });
  });

  it.each([
    ["nothing was sent", null],
    ["it is not JSON", "{oops"],
    ["the screen is unknown", JSON.stringify({ screen: "admin" })],
    ["the app screen has no user", JSON.stringify({ screen: "app", signOutUrl, renewUrl, switchAccountUrl })],
    ["the app screen has no renewal link", JSON.stringify({ screen: "app", user, signOutUrl, switchAccountUrl })],
  ])("falls back to the temporary-problem screen when %s", (_name, text) => {
    if (text !== null) embed(text);

    expect(readBoot(document)).toEqual({ screen: "unavailable" });
  });
});

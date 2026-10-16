# Accessibility of the member upload page

How the page at `media.sdfwa.org/upload` is checked against the target agreed on
[#31](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/31)
(WCAG 2.2 AA, plus the senior-friendly targets), what the checks found, and what still
needs a person with a phone and a screen reader. Built in
[#62](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/62).

## How it is checked

`upload/a11y/` holds Playwright tests that run the **built page** (`dist/web`) in a real
Chromium at a phone's width (390 px). The upload service is faked at the network
(`a11y/fake-service.ts`): the page is served with its boot data and the service's own
Content-Security-Policy, and each test decides how the service answers each photo, which
is how every state from [#30](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/30)
is reached. Long waits (ten minutes of automatic tries) run on Playwright's fake clock.

* `a11y/every-state.spec.ts`: [axe-core](https://github.com/dequelabs/axe-core) (through
  `@axe-core/playwright`) with the WCAG 2.0, 2.1 and 2.2 A and AA rules plus axe's best
  practices, over every screen and state. Nothing is excluded. Colour contrast is
  measured as drawn, which a jsdom test cannot do.
* `a11y/target.spec.ts`: the rest of #31's target, scripted (below).

Run them in `upload/` with `npm run test:a11y` (see the README). CI runs them on every pull
request in the `Accessibility checks` job of `.github/workflows/upload-checks.yml`.

### Screens and states axe covers

| Screen or state | Test |
|---|---|
| Not a member (403) | `pages the service chooses › not a member (403)` |
| Sharing paused (kill switch) | `› sharing paused` |
| Unavailable (auth outage) | `› unavailable` |
| The signed-in tab, `/upload/signed-in` | `› the signed-in tab` |
| Step 1, nothing chosen | `Steps 1 to 3 › Step 1, nothing chosen` |
| Step 1, chosen (photo, video without a preview), "We couldn't add some files" | `› Step 1, chosen, with some that couldn't be added` |
| The gallery's viewer dialog | `› Step 1, the gallery's viewer` |
| Step 2, empty (Still needed, Next disabled), answered, and the lists failing to load | three `Step 2` tests |
| Step 3 with a Changed tile, and the change dialog | two `Step 3` tests |
| Sending: Waiting, Sending (with its bar), Finishing up (video line and moving bar), Sent, Connection trouble, Couldn't save (Try again), Can't be added (Remove) | `sending › every Item state at once` |
| Busy: the page's "We're busy right now. We'll keep trying" notice; then, after every automatic try, the Item's own busy line and Waiting for your connection | `sending › busy` |
| The offline banner | `sending › offline banner` |
| Signed out, and membership lapsed, part way through | two `sending` tests |
| Thank you (all sent), Most of your photos are in, and thank you after "I'll do the rest later" | three `the end` tests |

## #31's target: results

Checked on 2026-10-14 against `@sdwa/components` 0.4.1 and `@sdwa/tokens` 0.4.0.

| Target | How | Result |
|---|---|---|
| WCAG 2.2 AA (automated part) | axe, every screen and state above | **Pass** after the fixes below |
| Keyboard only | Scripted: Tab and Enter, Space, the arrow keys and Escape from choosing to the thank-you, the viewer and Step 3's dialog (each gives the focus back to its tile), Remove and Try again while sending. Each control shows its focus ring when reached. | **Pass** |
| Focus moves to the step heading on each step change | Scripted: Steps 1 to 3 forward, the page's Back, the browser's Back, Sending, the thank-you and Most of your photos are in. Not on first load (the page starts at the top). | **Pass** |
| Screen readers hear each Item's state, not every percent | Scripted: each Item's state line is its own polite live region (`role="status"`); the percent and the bars are outside every live region; from Send to the thank-you, a live region only ever changes to a state's words. Each bar is named by its file. | **Pass** for the markup. What a real screen reader says needs VoiceOver and TalkBack (below). |
| Reduced motion | Scripted: with "reduce motion" set, nothing on the page animates (the Finishing up bar's pulse and the bar's growth stop); without it, the pulse runs, so the check is meaningful. Nothing else on the page moves. | **Pass** |
| 320 px wide, no sideways scrolling | Scripted on 10 screens, including the gallery, both dialogs, the sending list with every kind of line, and long camera file names | **Pass** after the fixes below |
| 200% text | Scripted as a browser text size of double (the page's root size is now a percentage of it), at 390 px, on the same 10 screens | **Pass** after the fixes below. A phone's own text setting still needs a look (below). |
| Status uses an icon and words, never colour alone | Scripted: with every colour removed, each Item's line still says what it is, and no two states read alike; every problem line (Connection trouble, Waiting for your connection, Couldn't save, Can't be added, busy), each row of Most of your photos are in, and the busy, offline and signed-out notices carry a ⚠ (hidden from screen readers; the words say it), Sent its ✓, the lapsed-membership notice the design system's icon by its title; the Changed badge is a word (and in the tile's name); the step bar is backed by "Step n of 4"; the required star by the legend and the Still-needed line. | **Pass** |
| Touch targets at least 48 px | Scripted: every control on the same 10 screens and an open list of choices is at least 48 × 48 px | **Pass**, except "Sign out" in the header, a link inside a sentence (WCAG's inline exception), left as it is by decision on #86. |
| Contrast re-measured with the current tokens | Scripted: the browser draws each pair (so tints are composited as shown) and the ratio is computed; the text pairs must pass | Table below |

### Contrast (light theme, tokens 0.4.0)

Measured by `target.spec.ts › contrast`. The "#31" column is the earlier calculation on #31,
before the design-system fixes of #39.

| Pair | #31 | Now | Needs | Result |
|---|---|---|---|---|
| Body text on page | 14.9 | 14.92 | 4.5 | pass |
| Muted text on page / card | 5.4 / 5.8 | 5.42 / 5.77 | 4.5 | pass |
| Primary / secondary button text | 5.9 / 7.2 | 5.88 / 7.22 | 4.5 | pass |
| Red text on page (required star, errors) | 3.54 | **4.89** | 4.5 | pass (fixed in #39) |
| White text on the red button | 3.87 | **5.34** | 4.5 | pass (fixed in #39) |
| Text-field border against the page | 1.31 | **3.20** | 3 | pass (fixed in #39) |
| Focus ring against the page | 7.4 | 7.41 | 3 | pass |
| Step bar and progress bar (primary) against the page | | 5.38 | 3 | pass |
| Body text on the thank-you's green tint / the warning tint | | 12.06 / 12.52 | 4.5 | pass |
| Card and divider border against the page | 2.34 | 2.34 | 3 | fails; left as decided on #31 (the dividers are decoration; every control has its own border) |
| Notification body text (grey) on the info tint | | 4.27 | 4.5 | **fails**: design system (follow-up 1); the page no longer uses it |
| Notification body text (grey) on the warning tint | | 4.55 | 4.5 | passes by a hair; the page no longer uses it |
| Red text on the warning tint | | 4.11 | 4.5 | fails; no longer drawn (fix 3) |

## What the checks found, and the fixes

1. **Unreadable "preview not available" box** (axe: colour contrast 1.22:1). A photo or video
   the browser can't show was drawn as grey text on the dark green `secondary` fill. It is now
   dark text on the light `accent` fill. In a small square (the sending list, a tile on a narrow
   phone), the long words were cut off; there it now says only "Video" or "Photo" (new copy,
   marked for a read-through in `copy.ts`). Same fix in the viewer's "can't be shown" box.
2. **Grey text in the busy, offline and signed-out notices** (axe: 4.27:1 on the info tint).
   The design system's `Notification` greys its body text. The page's notices now set their
   text at full strength and at the page's size (`text-lg`).
3. **Red status on "Most of your photos are in"** (axe: 4.07:1 on the warning tint). The lines
   there are now full-strength text; the words already say what went wrong.
4. **Tapping a tile on a 320 px phone hit the ✕.** In three columns on a narrow phone (or a
   phone's zoomed display), the ✕ covered the middle of each tile, where a member taps to see
   it bigger. Narrow galleries now have two columns (six rows, so twelve still show at once),
   and the ✕ is exactly 48 px in the very corner.
5. **Sideways scrolling with big text.** A camera's file name ("IMG_20240503_101112.gif") in
   "We couldn't add some files" could not break; and on "Most of your photos are in" the
   picture and the words could not fit side by side. The name now breaks anywhere, and the
   words go under the picture when they don't fit.
6. **Problems had no icon** (#31: "an icon and words"). Each problem line, each row of Most
   of your photos are in, and the title-less busy, offline and signed-out notices now start
   with a ⚠, drawn inline as text like Sent's ✓ (with U+FE0E, so phones don't draw a colour
   emoji) and hidden from screen readers. Decided on #86.
7. **The member's own text size was ignored.** The page set its root size as `18px`, which
   overrides a browser's text size setting. It is now `112.5%`: 18 px at the usual setting, and
   larger when the member asks for larger.

## Design-system follow-ups (`@sdwa/components`, not changed here)

1. **`Notification`: body text is greyed.** Its body is wrapped in `text-muted-foreground`
   (4.27:1 on the info tint, 4.55:1 on the warning tint), and `text-sm`. Suggested fix: use
   `text-foreground` for the body (the title already is), and inherit the text size from the
   field size (`text-base`/`text-lg` at `large`).
2. **`Notification`: no icon without a title.** The variant's icon is drawn only next to a
   title, so the page draws its own ⚠ in the offline, busy and signed-out notices. Suggested
   fix: draw the icon at the start of the body when there is no title (the page's ⚠ can then go).
3. **`Notification`: may not be announced when it appears.** It renders `role="status"`
   (`role="alert"` for errors) together with its message, and some screen readers announce
   only changes to a live region that is already on the page. Suggested fix: document that the
   live region should be mounted empty first, or offer a variant that keeps an always-present
   live region and fills it. (Confirm with VoiceOver and TalkBack first; see below.)
4. **`ProgressBar`: the percent is `text-sm` and grey.** It passes (5.42:1), but is small for
   this audience. Suggested fix: size the value text from the field size, like the other
   components.

## Still needed: a person, a phone and a screen reader (for Isaac)

These can't be checked from a test runner. Each is a short pass with the page, on the
devices #31 names: iPhone Safari (current and one version back), Chrome on Android, and
desktop Chrome and Safari. (CI runs only Chromium; WebKit, iOS and Android are not covered.)

- [ ] **VoiceOver on iPhone**, the whole way through: choose (the photo picker), Step 2 (the
      lists of choices, the checkboxes, the required fields), Step 3 (open a tile's dialog,
      change something, close it), Send, the thank-you. Listen for:
  - [ ] each step's heading read out when the step changes;
  - [ ] each photo's state read once when it changes ("Sending", "Finishing up", "Sent",
        "Couldn't save this one"), and the percent never read by itself;
  - [ ] the progress bar, when you move to it, read with its file name and percent;
  - [ ] the offline, busy and signed-out notices read when they appear (design-system
        follow-up 3); turn on Airplane mode while sending to get the offline one;
  - [ ] each dialog keeping VoiceOver inside it until closed, and returning to its tile;
  - [ ] "Sign in again" opening a new tab, and coming back.
- [ ] **TalkBack on Android**, the same pass.
- [ ] **A phone's own big text**: iPhone Safari's page zoom (aA, 200%) and Settings › Display
      › Text Size; Android's font size at its largest. The page should get bigger with no
      sideways scrolling.
- [ ] **A real 320 px screen**: an iPhone with Display Zoom on, or a small Android. The
      gallery should be two columns, and tapping a tile's middle should open it, not take it
      out.
- [ ] **Reduce Motion** on the phone: Finishing up's bar should stop pulsing.
- [ ] The observation sessions and the pilot on #31 (5 to 8 members aged 60 and over).

## Decided on #86

- Problem lines and title-less notices get a ⚠ as well as their words (fix 6).
- "Sign out" in the header stays an inline link.
- Narrow galleries stay at 2 columns below 340 px, pending a design review.

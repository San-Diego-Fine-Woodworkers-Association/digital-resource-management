# Design system components and Uppy fit for the upload UI

Research for issue #16 (map #12, Member Media Upload). Facts and open risks only; nothing was built.
Vocabulary follows `CONTEXT.md` (Submission, Item, Submitter, Batch metadata).

Sources:
- Design system repo, read-only checkout at `/var/home/isaachsmith/Repositories/SDFWA/design-system` (`@sdwa/components` 0.2.1, `@sdwa/tokens` 0.3.0), referred to below as `DS/`.
- Existing consumer: `Digital-Services/apps/auth` (the only app using `@sdwa/*` today).
- `react-aria-components` 1.21.1 as installed in the DS lockfile (`DS/bun.lock`, type definitions under `DS/node_modules/.bun/react-aria-components@1.21.1+*/`).
- Uppy official docs (uppy.io) and the published npm packages (source inspected after `npm i` in a scratch dir, versions below).

## 1. What `@sdwa/components` provides today

Exported from `DS/packages/components/src/index.ts`:

| Export | Based on | Upload-form use |
|---|---|---|
| `Button` (variants primary, secondary, destructive, quiet) | RAC `Button` | Pick/Upload/Remove actions |
| `Form`, `TextField`, `Label`, `Input`, `Description`, `FieldError`, `FieldGroup` (Label+Input+FieldError bundle) | RAC `Form`/`TextField`/... | Batch metadata text fields (title, description, etc.), RS-required-field validation messages |
| `Card`, `CardContent` | plain div | Per-Item row/panel, confirmation screen |
| `Collapsible` (+Trigger, Content) | RAC `Disclosure` | Per-Item "override Batch metadata" section |
| `Dialog`, `Modal`, `ModalOverlay`, `Popover` | RAC | Confirm remove, per-Item metadata editor on phone |
| `Notification` (error/success/info/warning, optional dismiss and actions) | hand-rolled div, `role="alert"` for error, `role="status"` otherwise | Per-Item/Submission errors, "done, a volunteer will review these" |
| `AppLayout` (`theme` prop required) | `@sdwa/tokens` `ThemeProvider` with `context="app"` | App shell background and tokens |
| `Link` | RAC `Link` | Navigation |

Tokens (`DS/packages/tokens/src/theme.css`): light/dark colors incl. `--success`, `--warning`, `--info`, `--destructive`, `--border`, `--input`, `--ring`; `--radius`; two density contexts (`app`, `content`); self-hosted Inter/Merriweather/JetBrains Mono (no `next/font` or Google Fonts needed, per `DS/packages/tokens/README.md`).

### Not wrapped by the design system (gaps)

Absent from `DS/packages/components/src/index.ts`: file picker, drop zone, progress bar, tag/chip list, toast, select/combobox, textarea, checkbox/radio, list/table/grid list. Per-Item metadata with dropdowns (e.g. RS fixed-list fields) would need Select/Checkbox/RadioGroup wrappers.

The underlying primitives do exist in the pinned `react-aria-components@1.21.1` (directories `DropZone`, `FileTrigger`, `ProgressBar`, `Meter`, `TagGroup`, `GridList`, `Select`, `TextArea`, `Checkbox`, `RadioGroup`, `Toast`), so gaps are "wrap and style" work, not missing capability. Relevant API (from `dist/types/src/FileTrigger.d.ts`, `DropZone.d.ts`, `ProgressBar.d.ts`):
- `FileTrigger`: `acceptedFileTypes`, `allowsMultiple`, `defaultCamera?: 'user' | 'environment'`, `acceptDirectory`, `onSelect(files: FileList | null)`. It wraps any RAC pressable (e.g. the DS `Button`) and opens the native picker.
- `DropZone`: `onDrop`, `getDropOperation`, `isDisabled`, aria-label props. Drag-and-drop is a desktop affordance; on a phone `FileTrigger` is the path.
- `ProgressBar`: accessible progressbar with value/percentage render props.
- Toast: only `UNSTABLE_` exports. The DS deliberately avoided it (comment in `DS/packages/components/src/Molecules/Notification.tsx` cites `docs/research/react-aria-toast-stability.md`, a file that is not present in the DS checkout). Treat toast as unavailable; use `Notification`.

The DS is "thin wrappers" with an extension convention (`composeTailwindRenderProps`, `data-[...]` state classes); adding wrappers is the documented pattern, but it means a DS release (changesets, `DS/PUBLISHING.md`) before this app can consume them, or a local wrapper in this app.

## 2. How an app consumes the package

From `Digital-Services/apps/auth` (`package.json`, `app/globals.css`, `app/layout.tsx`):
- Install from the public npm registry: `@sdwa/components` and `@sdwa/tokens` (`publishConfig.access: public`). No private registry or shadcn-style copy-in.
- CSS entry: `@import "@sdwa/tokens/theme.css";` (theme.css itself does `@import "tailwindcss"`, so Tailwind v4 is required in the consumer).
- Tailwind does not scan `node_modules`, so the consumer must add `@source "../node_modules/@sdwa/components/dist/**/*.{js,cjs}";` (explained in auth's `globals.css`). Without it component utility classes are missing.
- Wrap the app in `<AppLayout theme="light">`. `theme` is required; the app owns theme choice.
- `peerDependencies`: `react` and `react-dom` `^19.3.0` (`DS/packages/components/package.json`); auth declares `^19.2.4`. Check the resolved React version for a new SPA.
- DS dev stack: Tailwind 4.3, Vite 8 (Storybook), tsup; components are marked `"use client"` (harmless in a Vite SPA).

## 3. Uppy

Versions seen on npm (Oct 2026): `@uppy/core` 6.2.0, `@uppy/dashboard` 6.0.1, `@uppy/xhr-upload` 6.0.1, `@uppy/react` 6.0.0 (peers react 18 or 19), `@uppy/components` 2.0.0, `@uppy/compressor` 4.0.0, `@uppy/golden-retriever` 6.0.0. All MIT.

### Two integration shapes

**A. Dashboard** (`@uppy/dashboard`, `@uppy/react` `<Dashboard />`; https://uppy.io/docs/dashboard/, https://uppy.io/docs/react/): complete prebuilt UI with its own CSS (`@uppy/core/css/style.min.css`, `@uppy/dashboard/css/style.min.css`).
- Per-Item metadata: `metaFields` option gives an "edit" button per file opening a metadata panel; fields can be static or chosen per file type. No notion of Batch metadata applied to all with per-Item override in the docs; core has `meta` (applied to every file) and `setMeta`/`setFileMeta` (https://uppy.io/docs/uppy/), so that model would have to be composed by us.
- Theming: `theme: 'light' | 'dark' | 'auto'` only plus CSS overrides. Dashboard CSS is a separate visual language (own buttons, modal, status bar), not driven by `@sdwa/tokens`. Strings customizable via `locale`; powered-by branding on by default (`proudlyDisplayPoweredByUppy`).
- Accessibility: docs say only that it has screen-reader labels and keyboard support for modal controls; no conformance claim. Source contains ARIA roles (`dashboard/src/components/EditorPanel.tsx`: tabpanel, heading). Not tested here.
- Size (measured: esbuild minified, React externalized, gzip): core + XHR only 18 KB gz; with Dashboard 80 KB gz JS plus 24 KB gz CSS (`@uppy/dashboard` 22.4 KB, `@uppy/core` 1.8 KB). For reference, the RAC subset (FileTrigger, DropZone, ProgressBar, Button, TagGroup) measured 62 KB gz and is already a DS dependency.

**B. Headless core + our UI** (`@uppy/core` + `@uppy/xhr-upload`, optionally `@uppy/react`/`@uppy/components` headless parts; https://uppy.io/docs/react/):
- Uppy core holds file state, restrictions, per-file meta, progress and events; we render everything with DS components. Core events: `upload-progress` (per file), `upload-success`, `upload-error`, `progress`, `complete`.
- `@uppy/react` 6 exposes `useUppyState`, `useUppyEvent`, `useFileInput`, `useDropzone`, plus headless `Dropzone`, `FilesList`, `FilesGrid`, `UploadButton` inside `UppyContextProvider`. The shipped headless components are pre-styled with `uppy:`-prefixed Tailwind (gray/blue, hard-coded English strings, e.g. "Drop files here or click to add them" in `@uppy/components/src/Dropzone.tsx`), so we would use the hooks (`createFileInput` returns `getInputProps`/`getButtonProps`, honoring `restrictions.allowedFileTypes` as `accept`) rather than the components. The docs page for individual headless components (https://uppy.io/docs/react/dropzone/) returned 404; detail came from package source.
- Equivalent without Uppy: DS `FileTrigger`/`Button` supplies the picker; we would hand-write queue state, per-file progress, retry, concurrency and limits.

### Requirement-by-requirement

- **Custom proxy endpoint** (fits both): `@uppy/xhr-upload` (https://uppy.io/docs/xhr-upload/) posts `multipart/form-data` to `endpoint` (any URL, `method`, `headers` static or function, `withCredentials`, `fieldName`, `formData`, `bundle` for one request per Submission or default one per Item, `limit` parallel default 5). Per-file meta is sent as extra form fields, filtered by `allowedMetaFields`. `getResponseData`/`validateStatus` handle our response shape. `onBeforeRequest` runs on every attempt (e.g. attach a fresh session header). Cookie-based SDFWA session works with `withCredentials` if the proxy is same-origin (`media.sdfwa.org/upload`, so not needed).
- **Per-file progress**: built in (`upload-progress`, file `progress.percentage`).
- **Retries / flaky mobile**: XHR has `timeout` default 30 s measured between progress events (not total), `shouldRetry` with up to 3 retries and exponential backoff (docs). XHR Upload is a plain single-request upload: no chunking or resume (docs contrast it with Tus). A large video over a bad connection restarts from byte 0 on retry. Resumable uploads are out of scope on the map unless free; they are not free with XHR (would need Tus and a Tus-capable proxy, which is not how the RS API ingests files).
- **Restrictions**: core `restrictions` (`maxFileSize`, `maxNumberOfFiles`, `minNumberOfFiles`, `allowedFileTypes`, `requiredMetaFields`) plus hooks `onBeforeFileAdded`/`onBeforeUpload`. `requiredMetaFields` covers "RS-defined required fields enforced" client-side; the proxy must still enforce.
- **Phone camera-roll selection**: both paths use a native `<input type="file" multiple accept=...>`, which on iOS and Android opens the photo library/picker. `FileTrigger` also offers `defaultCamera` for direct capture; Uppy's Dashboard has separate Webcam plugin (not needed). Behavior on real devices is not verified here.
- **HEIC**: Uppy core only maps extensions to MIME types (`@uppy/core/src/utils/mimeTypes.ts`: `heic`, `heif`). Uppy's docs do not mention HEIC conversion; Thumbnail Generator and Compressor docs (https://uppy.io/docs/thumbnail-generator/, https://uppy.io/docs/compressor/) say nothing about HEIC and rely on what the browser can decode, so HEIC thumbnails will likely be blank outside Safari (unverified; needs a device test). Neither Uppy path converts HEIC to JPEG; if we want conversion client-side it needs a separate library, or upload HEIC as-is and leave HEIC handling to the ResourceSpace side (not researched here). How iOS hands the file to the page (original HEIC vs auto-converted JPEG depending on `accept` values) is unverified here and should be tested on a device.
- **Accessibility for older, non-technical users**: DS path inherits RAC's keyboard/focus/ARIA work and the DS `Notification` live regions (`role="alert"`/`"status"`), plus the DS `--ring` focus token. Dashboard's a11y is documented only at a high level; its modal-in-modal metadata editor and small controls are unvalidated for this audience.
- **Theming**: headless path matches `@sdwa/tokens` automatically. Dashboard needs CSS overrides to approximate the tokens (and DS conventions `data-theme`/`data-context` do not reach it).
- **Bundle**: see sizes above. Headless core+XHR adds about 18 KB gz; Dashboard adds about 104 KB gz JS+CSS.

### Summary comparison

| | Dashboard | Uppy core + XHR, DS UI | Pure custom (no Uppy), DS UI |
|---|---|---|---|
| Visual/token fit | separate look | native | native |
| Per-file meta editing UI | built in (`metaFields`) | build with DS fields | build |
| Batch metadata + override | compose by hand | compose by hand (`setMeta`/`setFileMeta`) | build |
| Queue, per-file progress, retry, limits, restrictions | built in | built in | build |
| Proxy endpoint | `xhr-upload` | `xhr-upload` | `fetch`/XHR we write (note: `fetch` has no upload progress events) |
| Added gz size | about 104 KB | about 18 KB | 0 (plus our code) |
| New DS components needed | none | list, progress, select, file trigger wrappers | same |

## 4. Open risks

1. DS gaps: no DropZone/FileTrigger/ProgressBar/Select/TagGroup/TextArea/Checkbox wrappers; need adding in DS (release cycle) or locally. Toast is deliberately unavailable.
2. `@sdwa/components` peers `react ^19.3.0`; verify the SPA's React version resolves cleanly.
3. HEIC: no Uppy-side conversion; thumbnails and iOS file handling must be tested on real iPhones. Decision needed on convert-in-browser vs let RS handle HEIC.
4. XHR Upload is non-resumable; a 30 s no-progress timeout and 3 retries per request apply by default; large videos on poor mobile networks may fail repeatedly. Needs a decision on timeouts and size limits.
5. Per-Item overrides of Batch metadata is a UX we compose ourselves in every option.
6. Dashboard accessibility is unvalidated for older users; no tests done here.
7. Uppy 6.x is a recent major (core 6.2.0, `@uppy/react` 6.0.0); docs page for headless components 404'd, so headless API detail was taken from published source, which may change.
8. The DS `docs/research/react-aria-toast-stability.md` cited in `Notification.tsx` is missing from the checkout.
9. Sizes were measured with esbuild in a scratch dir (React externalized, no app code), not in the final build.

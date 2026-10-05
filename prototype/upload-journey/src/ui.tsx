// Small shared widgets. Layouts are NOT shared: each variant owns its structure.
import { useState, type ReactNode } from "react";
import { FileTrigger, ProgressBar } from "react-aria-components";
import { Button, FieldGroup, type ButtonProps } from "@sdwa/components";
import { ACCEPT } from "./lib/limits";
import { EVENTS, type Meta } from "./lib/fields";
import type { Item } from "./lib/useSubmission";

// The design system's Button is text-sm / py-2. Too small for this audience:
// the app layer enlarges it. (Finding for the real build / DS "size" prop.)
export function BigButton({ className = "", ...props }: ButtonProps) {
  return <Button {...props} className={`min-h-14 px-6 text-lg font-semibold ${className}`} />;
}

export function PickFilesButton({
  onSelect, label = "Choose photos and videos", variant = "primary", className = "",
}: { onSelect: (f: FileList | null) => void; label?: string; variant?: ButtonProps["variant"]; className?: string }) {
  return (
    <FileTrigger acceptedFileTypes={ACCEPT} allowsMultiple onSelect={onSelect}>
      <BigButton variant={variant} className={`w-full ${className}`}>{label}</BigButton>
    </FileTrigger>
  );
}

export function Bar({ value, label }: { value: number; label: string }) {
  return (
    <ProgressBar value={value} aria-label={label} className="w-full">
      {({ percentage }) => (
        <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${percentage}%` }} />
        </div>
      )}
    </ProgressBar>
  );
}

export function Thumb({ item, className = "" }: { item: Item; className?: string }) {
  const [broken, setBroken] = useState(false);
  const base = `object-cover bg-secondary ${className}`;
  if (item.kind === "video")
    return (
      <div className={`relative ${className}`}>
        <video src={item.url + "#t=0.1"} preload="metadata" muted playsInline className={`h-full w-full ${base}`} />
        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-2 text-sm text-white">Video</span>
      </div>
    );
  if (broken)
    return (
      <div className={`flex flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground ${base}`}>
        <span aria-hidden className="text-3xl">🖼</span>
        Photo (preview not available)
      </div>
    );
  return <img src={item.url} alt={item.file.name} onError={() => setBroken(true)} className={base} />;
}

export function StatusText({ item }: { item: Item }) {
  if (item.status === "done") return <span className="font-medium text-success">✓ Sent</span>;
  if (item.status === "retrying") return <span className="font-medium text-warning">Connection dropped. Trying again…</span>;
  if (item.status === "sending") return <span className="text-muted-foreground">Sending… {item.progress}%</span>;
  return <span className="text-muted-foreground">Waiting</span>;
}

const selectCls =
  "min-h-12 rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring";

export function MetaFields({
  value, onChange, override = false, showPermission = true,
}: { value: Partial<Meta>; onChange: (p: Partial<Meta>) => void; override?: boolean; showPermission?: boolean }) {
  const same = override ? "Same as the others" : "Choose…";
  const text = (k: "description" | "people", label: string, hint?: string) => (
    <FieldGroup
      label={label}
      value={(value[k] as string) ?? ""}
      onChange={(v) => onChange({ [k]: v })}
      inputProps={{ placeholder: override ? "Same as the others" : hint, className: "min-h-12 text-base" }}
    />
  );
  return (
    <div className="flex flex-col gap-4">
      {text("description", "What are these?", "For example: Dovetail class, May 3")}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Where were they taken?</span>
        <select className={selectCls} value={value.event ?? ""} onChange={(e) => onChange({ event: e.target.value })}>
          <option value="">{same}</option>
          {EVENTS.map((e) => <option key={e}>{e}</option>)}
        </select>
      </label>
      <FieldGroup
        label="When were they taken?"
        type="date"
        value={value.date ?? ""}
        onChange={(v) => onChange({ date: v })}
        inputProps={{ className: "min-h-12 text-base" }}
      />
      {text("people", "Who is in them? (optional)", "Names, separated by commas")}
      {showPermission && (
        <label className="flex items-start gap-3 text-base">
          <input type="checkbox" className="mt-1 size-6 shrink-0 accent-[var(--primary)]" checked={!!value.permission}
            onChange={(e) => onChange({ permission: e.target.checked })} />
          <span>I took these, or I have permission to share them with SDFWA</span>
        </label>
      )}
    </div>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 px-4 pb-32 pt-6">
      <header className="flex flex-col gap-1 border-b border-border pb-4">
        <p className="text-sm text-muted-foreground">SDFWA Media</p>
        <h1 className="text-2xl font-bold">Share your photos and videos</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as Pat Member. <span className="underline">Not you? Sign out</span>
        </p>
      </header>
      {children}
    </div>
  );
}

export function Done({ photos, videos, onMore }: { photos: number; videos: number; onMore: () => void }) {
  const words = [photos && `${photos} photo${photos === 1 ? "" : "s"}`, videos && `${videos} video${videos === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  return (
    <div className="flex flex-col gap-5 rounded-lg border border-success/40 bg-success/15 p-6 text-center">
      <p aria-hidden className="text-5xl">✓</p>
      <h2 className="text-2xl font-bold">Thank you! We have your {words}.</h2>
      <p className="text-lg">
        A volunteer will take a look before they appear on the SDFWA media site. You don't need to do anything else, and you can close this page.
      </p>
      <BigButton variant="secondary" onPress={onMore}>Share more photos or videos</BigButton>
    </div>
  );
}

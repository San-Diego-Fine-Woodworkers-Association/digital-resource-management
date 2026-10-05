// PROTOTYPE, THROWAWAY. Question: what should the phone-first upload journey look like?
// Three structurally different variants, switched with ?variant=A|B|C (or the arrows).
// Also: ?screen=forbidden shows the friendly 403 page. No network, no persistence.
import { useEffect, useState } from "react";
import { AppLayout } from "@sdwa/components";
import { VariantA } from "./variants/VariantA";
import { VariantB } from "./variants/VariantB";
import { VariantC } from "./variants/VariantC";
import { Forbidden } from "./Forbidden";

const VARIANTS = [
  { key: "A", name: "One page" },
  { key: "B", name: "Guided steps" },
  { key: "C", name: "Send as you go" },
] as const;

function param(name: string) { return new URLSearchParams(location.search).get(name); }

export function App() {
  const [variant, setVariant] = useState(param("variant") ?? "A");
  const [flaky, setFlaky] = useState(false);
  const screen = param("screen");
  const idx = Math.max(0, VARIANTS.findIndex((v) => v.key === variant));

  const go = (i: number) => {
    const key = VARIANTS[(i + VARIANTS.length) % VARIANTS.length].key;
    const u = new URL(location.href); u.searchParams.set("variant", key);
    history.replaceState(null, "", u); setVariant(key);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable]")) return;
      if (e.key === "ArrowLeft") go(idx - 1);
      if (e.key === "ArrowRight") go(idx + 1);
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });

  return (
    <AppLayout theme="light">
      {screen === "forbidden" ? <Forbidden /> : (
        // key forces a fresh state when switching variants or toggling flaky
        <div key={variant + flaky}>
          {variant === "A" && <VariantA flaky={flaky} />}
          {variant === "B" && <VariantB flaky={flaky} />}
          {variant === "C" && <VariantC flaky={flaky} />}
        </div>
      )}
      <div className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black px-3 py-2 text-sm text-white shadow-lg">
        <button aria-label="Previous variant" className="px-2 text-lg" onClick={() => go(idx - 1)}>←</button>
        <span className="whitespace-nowrap">{VARIANTS[idx].key} ({VARIANTS[idx].name})</span>
        <button aria-label="Next variant" className="px-2 text-lg" onClick={() => go(idx + 1)}>→</button>
        <label className="ml-2 flex items-center gap-1 border-l border-white/30 pl-3">
          <input type="checkbox" checked={flaky} onChange={(e) => setFlaky(e.target.checked)} /> flaky
        </label>
      </div>
    </AppLayout>
  );
}

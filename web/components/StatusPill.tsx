import type { Tone } from "@/lib/pipeline";

export function StatusPill({ label, tone, pulse }: { label: string; tone: Tone; pulse?: boolean }) {
  return (
    <span className={`pill pill-${tone}`}>
      <span className={`dot${pulse ? " dot-pulse" : ""}`} />
      {label}
    </span>
  );
}

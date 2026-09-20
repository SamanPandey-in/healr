import { fmtDuration } from "@/lib/format";
import type { Metric } from "@/lib/pipeline";

export function MetricsStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="metrics">
      {metrics.map((m, i) => (
        <div key={m.label} className={`metric${i === metrics.length - 1 ? " metric-hero" : ""}`} title={m.hint}>
          <div className="metric-value mono">{fmtDuration(m.value)}</div>
          <div className="metric-label">{m.label}</div>
        </div>
      ))}
    </div>
  );
}

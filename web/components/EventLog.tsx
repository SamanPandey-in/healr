import { fmtClock } from "@/lib/format";
import type { ExecutionEvent } from "@/lib/types";

const tone = (t: string) =>
  /Failed|TimedOut|Aborted/.test(t) ? "ev-bad" : /Succeeded|Exited/.test(t) ? "ev-good" : /Entered|Started/.test(t) ? "ev-info" : "";

export function EventLog({ events }: { events: ExecutionEvent[] }) {
  return (
    <section className="card">
      <header className="card-head">
        <span className="eyebrow">Step Functions event history</span>
        <span className="tag">{events.length} events · raw from GetExecutionHistory</span>
      </header>
      <div className="log" role="log">
        {events.map((e) => (
          <div key={e.id} className={`log-row ${tone(e.type)}`}>
            <span className="mono dim">#{String(e.id).padStart(2, "0")}</span>
            <span className="mono dim">{fmtClock(e.timestamp, true)}</span>
            <span className="mono ev-type">{e.type}</span>
            <span className="mono dim">{e.state ?? ""}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

import type { IncidentBundle } from "@/lib/types";

export function OutcomePanel({ incident }: { incident: IncidentBundle }) {
  const r = incident.REMEDIATION;
  const v = incident.VERIFICATION;
  if (!r && !v) return null;
  const max = Math.max(1, v?.faultCountBefore ?? 0, v?.faultCountAfter ?? 0);
  return (
    <section className="card">
      <header className="card-head"><span className="eyebrow">Outcome</span></header>
      {r && (
        <div className="rollback">
          <div className="dim small">Lambda alias rollback · {r.service}</div>
          <div className="versions">
            <span className="ver ver-bad">v{r.revertedFromVersion}</span>
            <span className="ver-arrow">→</span>
            <span className="ver ver-good">v{r.revertedToVersion}</span>
          </div>
        </div>
      )}
      {v && (
        <div className="verify">
          <div className="dim small">Injected faults in a 5-minute window</div>
          {([["Before fix", v.faultCountBefore, "bad"], ["After fix", v.faultCountAfter, v.recovered ? "good" : "bad"]] as const).map(([label, n, tone]) => (
            <div className="vrow" key={label}>
              <span className="small">{label}</span>
              <div className="bar bar-thick"><i className={`fill-${tone}`} style={{ width: `${(n / max) * 100}%` }} /></div>
              <span className="mono">{n}</span>
            </div>
          ))}
          <div className={`notice ${v.recovered ? "notice-green" : "notice-red"}`}>
            {v.recovered ? "Recovered — no new faults after the rollback." : "Not recovered — faults are still occurring."}
          </div>
        </div>
      )}
    </section>
  );
}

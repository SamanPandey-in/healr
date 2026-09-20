import { explainEvidence } from "@/lib/pipeline";
import type { IncidentBundle } from "@/lib/types";

export function DiagnosisPanel({ incident }: { incident: IncidentBundle }) {
  const d = incident.DIAGNOSIS;
  if (!d) {
    return (
      <section className="card">
        <header className="card-head"><span className="eyebrow">AI diagnosis</span></header>
        <p className="dim small">Waiting for <code>DiagnoseWithBedrock</code>…</p>
      </section>
    );
  }
  const pct = Math.round(d.confidence * 100);
  const C = 2 * Math.PI * 26;
  return (
    <section className="card">
      <header className="card-head">
        <span className="eyebrow">AI diagnosis</span>
        <span className="tag">every claim is citation-checked</span>
      </header>
      <div className="diag-top">
        <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={`Confidence ${pct}%`}>
          <circle cx="32" cy="32" r="26" className="gauge-bg" />
          <circle cx="32" cy="32" r="26" className="gauge" strokeDasharray={`${(pct / 100) * C} ${C}`} transform="rotate(-90 32 32)" />
          <text x="32" y="36" textAnchor="middle" className="gauge-num">{pct}%</text>
        </svg>
        <div>
          <div className="dim small">Root cause</div>
          <div className="big">{d.rootCauseService}</div>
        </div>
      </div>
      <p className="summary">{d.summary}</p>
      <div className="dim small" style={{ marginBottom: 8 }}>Cited evidence ({d.citedEvidenceIds.length})</div>
      <ul className="evidence">
        {d.citedEvidenceIds.map((id) => {
          const e = explainEvidence(id, d.rankedCandidates, incident.META?.alarmName);
          return (
            <li key={id}>
              <span className={`tag tag-${e.kind.toLowerCase()}`}>{e.kind}</span>
              <div>
                <div>{e.text}</div>
                <code className="dim small">{id}</code>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

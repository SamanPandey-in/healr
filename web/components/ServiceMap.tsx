import type { Candidate, IncidentBundle, Service } from "@/lib/types";

const NODES: { id: Service; x: number }[] = [
  { id: "gateway", x: 70 }, { id: "orders", x: 270 }, { id: "inventory", x: 470 },
];

export function ServiceMap({ incident }: { incident: IncidentBundle }) {
  const candidates: Candidate[] = incident.DIAGNOSIS?.rankedCandidates ?? incident.LOCALIZATION?.rankedCandidates ?? [];
  const root = incident.DIAGNOSIS?.rootCauseService ?? candidates[0]?.service;
  const alarming = incident.META?.service;
  const healed = incident.META?.status === "closed" && incident.VERIFICATION?.recovered;
  const top = Math.max(0.0001, ...candidates.map((c) => c.score));

  return (
    <section className="card">
      <header className="card-head"><span className="eyebrow">Service graph & root-cause ranking</span></header>
      <svg viewBox="0 0 540 120" className="map" role="img" aria-label="gateway calls orders calls inventory">
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="currentColor" />
          </marker>
        </defs>
        {NODES.slice(0, -1).map((n, i) => (
          <line key={n.id} x1={n.x + 42} y1={60} x2={NODES[i + 1].x - 46} y2={60} className="edge" markerEnd="url(#arrowhead)" />
        ))}
        {NODES.map((n) => {
          const isRoot = n.id === root && candidates.length > 0;
          const isAlarm = n.id === alarming;
          const tone = healed && isRoot ? "ok" : isRoot ? "root" : isAlarm ? "alarm" : "";
          return (
            <g key={n.id} transform={`translate(${n.x},60)`} className={`svc ${tone}`}>
              {(isRoot || isAlarm) && !healed && <circle r="44" className="ring" />}
              <circle r="36" className="disc" />
              <text y="4" textAnchor="middle" className="svc-name">{n.id}</text>
              {isRoot && <text y="-46" textAnchor="middle" className="svc-tag">{healed ? "HEALED" : "ROOT CAUSE"}</text>}
              {isAlarm && !isRoot && <text y="-46" textAnchor="middle" className="svc-tag">ALARM</text>}
            </g>
          );
        })}
      </svg>

      {candidates.length === 0 ? (
        <p className="dim small">Suspects appear once <code>LocalizeRootCause</code> finishes.</p>
      ) : (
        <div className="cands">
          {candidates.map((c, i) => (
            <div key={c.service} className={`cand${i === 0 ? " cand-top" : ""}`}>
              <div className="cand-row">
                <strong>{c.service}</strong>
                <span className="mono dim">score {c.score.toFixed(3)}</span>
              </div>
              <div className="bar"><i style={{ width: `${(c.score / top) * 100}%` }} /></div>
              <div className="dim small">
                {c.distanceFromAnomaly} hop{c.distanceFromAnomaly === 1 ? "" : "s"} from alarm ·{" "}
                {c.deployVersion ? `deploy v${c.deployVersion} landed ${Math.round(c.secondsBeforeAnomaly ?? 0)}s before the anomaly` : "no recent deploy on record"}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, armDemo, listIncidents, triggerOrder } from "@/lib/api";
import { usePoll, useNow } from "@/lib/usePoll";
import { PIPELINE, displayStatus } from "@/lib/pipeline";
import { ago, fmtDuration } from "@/lib/format";
import type { IncidentStatus, IncidentMeta } from "@/lib/types";
import { TopBar } from "@/components/TopBar";
import { StatusPill } from "@/components/StatusPill";
import { Icon } from "@/components/Icon";

type Phase = "idle" | "arming" | "firing" | "waiting" | "detected" | "busy";
const REQUESTS = 6;
const STAGES: IncidentStatus[] = ["open", "localized", "diagnosed", "remediated", "closed"];
const PHASE_STEPS = ["Arm fault injection", `Send ${REQUESTS} requests`, "CloudWatch alarm trips", "Pipeline starts"];
const PHASE_INDEX: Record<Phase, number> = { idle: -1, arming: 0, firing: 1, waiting: 2, detected: 4, busy: -1 };

export default function Home() {
  const router = useRouter();
  const list = usePoll(listIncidents, 3000);
  const incidents = (list.data ?? []).filter(
    (i): i is IncidentMeta => !!i && typeof (i as IncidentMeta).incidentId === "string"
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [sent, setSent] = useState(0);
  const [error, setError] = useState("");
  const baseline = useRef<Set<string> | null>(null); // incident ids that existed when the demo was triggered
  const startedAt = useRef(0);
  const now = useNow(phase === "waiting", 500);

  // When an incident appears that wasn't there before we triggered, jump straight to its console.
  const [target, setTarget] = useState<string>();
  useEffect(() => {
    if (phase !== "waiting" || !baseline.current) return;
    const fresh = incidents.find((i) => i.incidentId && !baseline.current!.has(i.incidentId));
    if (fresh?.incidentId) {
      setTarget(fresh.incidentId);
      setPhase("detected");
    }
  }, [incidents, phase]);
  useEffect(() => {
    if (phase !== "detected" || !target) return;
    const t = setTimeout(() => router.push(`/incidents/${target}`), 1400);
    return () => clearTimeout(t);
  }, [phase, target, router]);

  async function handleTrigger() {
    setError("");
    setSent(0);
    baseline.current = list.data
      ? new Set(list.data.filter((i) => typeof i?.incidentId === "string").map((i) => i.incidentId))
      : null;
    try {
      setPhase("arming");
      await armDemo();
      setPhase("firing");
      for (let i = 0; i < REQUESTS; i++) {
        await triggerOrder(`demo-${Date.now()}-${i}`);
        setSent(i + 1);
        await new Promise((r) => setTimeout(r, 800));
      }
      startedAt.current = Date.now();
      setPhase("waiting");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPhase("busy");
        list.refresh();
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("idle");
      }
    }
  }

  const running = phase === "arming" || phase === "firing";
  const at = PHASE_INDEX[phase];

  return (
    <main className="shell">
      <TopBar>
        <span className="live"><span className="dot dot-pulse" />Live AWS</span>
      </TopBar>

      <section className="hero">
        <span className="eyebrow"><Icon name="bolt" size={14} /> Causal root-cause localization · human-gated remediation</span>
        <h1>Break production. Watch it heal itself.</h1>
        <p className="lead">
          Trigger a real incident on live AWS infrastructure. Step Functions localizes the root cause, an AI diagnoses it with
          cited evidence, pauses for your approval, then rolls back and verifies — and you can watch every state, input and output as it happens.
        </p>
        <div className="flow">
          {PIPELINE.map((s, i) => (
            <span key={s.name} className="flow-item">
              <span className={`flow-chip${s.name === "RequestApproval" ? " flow-gate" : ""}`}>{s.label}</span>
              {i < PIPELINE.length - 1 && <Icon name="arrow" size={12} />}
            </span>
          ))}
        </div>
      </section>

      <section className="card launch">
        <div className="launch-top">
          <button className="btn btn-primary btn-lg" onClick={handleTrigger} disabled={running}>
            {running ? <span className="spinner" /> : <Icon name="bolt" size={18} />}
            {running ? "Working…" : "Trigger a live incident"}
          </button>
          <div className="dim small">
            {phase === "idle" && "Injects a fault into the inventory Lambda and sends traffic through it."}
            {phase === "firing" && `Sending request ${Math.min(sent + 1, REQUESTS)} of ${REQUESTS}…`}
            {phase === "waiting" && `Waiting for the CloudWatch alarm — typically 60–90s (${fmtDuration(now - startedAt.current)} so far)`}
            {phase === "detected" && "Incident detected — opening the live console…"}
            {phase === "busy" && "A demo is already running — open its incident below."}
          </div>
        </div>
        {phase !== "idle" && phase !== "busy" && (
          <ol className="phases">
            {PHASE_STEPS.map((label, i) => (
              <li key={label} className={i < at ? "done" : i === at ? "now" : ""}>
                <span className="phase-dot">{i < at ? <Icon name="check" size={12} /> : i + 1}</span>{label}
              </li>
            ))}
          </ol>
        )}
        {error && <div className="notice notice-red">{error}</div>}
      </section>

      <h2 className="section-title">Recent incidents</h2>
      {list.error && !list.data && <div className="notice notice-red">Can’t reach the API: {list.error}</div>}
      {incidents.length === 0 && !list.error && <p className="dim">No incidents yet — trigger one above.</p>}
      <div className="incident-grid">
        {incidents.map((i) => {
          const st = displayStatus({ META: i });
          const idx = STAGES.indexOf(i.status);
          const shortId = String(i.incidentId ?? "").slice(0, 8) || "—";
          return (
            <Link key={i.incidentId} href={`/incidents/${i.incidentId}`} className="card incident-card">
              <div className="incident-top">
                <code className="id">{shortId}</code>
                <StatusPill label={st.label} tone={st.tone} />
              </div>
              <div className="dim small">{i.alarmName ?? "—"} · {i.service ?? "—"} · {ago(i.createdAt)}</div>
              <div className="segments" aria-hidden="true">
                {STAGES.map((s, n) => <i key={s} className={n <= idx ? "on" : ""} />)}
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}

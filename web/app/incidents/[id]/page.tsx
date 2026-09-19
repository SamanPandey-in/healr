"use client";
import { useEffect, useState } from "react";
import { getIncident } from "@/lib/api";

export default function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const [incident, setIncident] = useState<any>(null);
  const [id, setId] = useState("");

  useEffect(() => {
    params.then((p) => {
      setId(p.id);
      getIncident(p.id).then(setIncident).catch(() => {});
    });
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const poll = setInterval(() => {
      getIncident(id).then(setIncident).catch(() => {});
    }, 3000);
    return () => clearInterval(poll);
  }, [id]);

  if (!incident) return <p style={{ padding: "2rem" }}>Loading...</p>;

  const meta = incident.META;
  const diagnosis = incident.DIAGNOSIS;
  const approval = incident.APPROVAL;
  const remediation = incident.REMEDIATION;
  const verification = incident.VERIFICATION;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <a href="/" style={{ color: "#2563eb", textDecoration: "none", fontSize: "0.9rem" }}>&larr; Back</a>
      <h1>Incident</h1>
      <p style={{ fontSize: "0.85rem", color: "#888", fontFamily: "monospace" }}>{id}</p>

      <div style={{ margin: "1.5rem 0", padding: "1rem", background: "#f9fafb", borderRadius: 8 }}>
        <p><strong>Status:</strong> {meta?.status ?? "unknown"}</p>
        <p><strong>Service:</strong> {meta?.service}</p>
        <p><strong>Alarm:</strong> {meta?.alarmName}</p>
        <p><strong>Detected:</strong> {meta?.detectedAt}</p>
      </div>

      {diagnosis && (
        <section style={{ margin: "1.5rem 0" }}>
          <h2>Diagnosis (Gemini)</h2>
          <p style={{ lineHeight: 1.6 }}>{diagnosis.summary}</p>
          <p><strong>Root cause:</strong> {diagnosis.rootCauseService} (confidence: {diagnosis.confidence})</p>
          <p><strong>Cited evidence:</strong></p>
          <ul>
            {diagnosis.citedEvidenceIds?.map((id: string) => (
              <li key={id} style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>{id}</li>
            ))}
          </ul>
        </section>
      )}

      {meta?.status === "diagnosed" && approval?.approveLink && (
        <section style={{ margin: "1.5rem 0" }}>
          <a
            href={approval.approveLink}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              padding: "0.6rem 1.4rem",
              background: "#16a34a",
              color: "#fff",
              borderRadius: 6,
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Approve remediation
          </a>
        </section>
      )}

      {remediation && (
        <section style={{ margin: "1.5rem 0" }}>
          <h2>Remediation</h2>
          <p>Reverted from version {remediation.revertedFromVersion} to {remediation.revertedToVersion}</p>
        </section>
      )}

      {verification && (
        <section style={{ margin: "1.5rem 0" }}>
          <h2>Verification</h2>
          <p>Recovered: {verification.recovered ? "Yes" : "No"}</p>
          <p>Faults before: {verification.faultCountBefore} | after: {verification.faultCountAfter}</p>
        </section>
      )}
    </main>
  );
}

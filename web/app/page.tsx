"use client";
import { useEffect, useState } from "react";
import { armDemo, triggerOrder, listIncidents } from "@/lib/api";

export default function Home() {
  const [incidents, setIncidents] = useState<any[]>([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    listIncidents().then(setIncidents).catch(() => {});
    const poll = setInterval(() => {
      listIncidents().then(setIncidents).catch(() => {});
    }, 4000);
    return () => clearInterval(poll);
  }, []);

  async function handleTrigger() {
    setError("");
    try {
      setStatus("arming");
      await armDemo();
      setStatus("firing requests");
      for (let i = 0; i < 6; i++) {
        await triggerOrder(`demo-${Date.now()}-${i}`);
        await new Promise((r) => setTimeout(r, 800));
      }
      setStatus("waiting for the alarm to trip (~60-90s)");
    } catch (e: any) {
      const msg = await e?.message ?? String(e);
      if (msg.includes("409")) {
        setStatus("a demo is already running");
        listIncidents().then((list) => {
          if (list.length > 0) setIncidents(list);
        });
      } else {
        setError(msg);
        setStatus("idle");
      }
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1>Self-Healing Infra</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        Trigger a real incident on live AWS infrastructure. Watch Gemini diagnose it
        with cited evidence, approve the fix, and see the system heal itself.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "1.5rem 0" }}>
        <button
          onClick={handleTrigger}
          disabled={status !== "idle" && status !== "waiting for the alarm to trip (~60-90s)" && status !== "a demo is already running"}
          style={{
            padding: "0.6rem 1.4rem",
            fontSize: "1rem",
            borderRadius: 6,
            border: "none",
            background: "#2563eb",
            color: "#fff",
            cursor: "pointer",
            opacity: status === "idle" || status === "waiting for the alarm to trip (~60-90s)" || status === "a demo is already running" ? 1 : 0.6,
          }}
        >
          Trigger a live incident
        </button>
        <span style={{ fontSize: "0.9rem", color: "#666" }}>{status}</span>
      </div>

      {error && <p style={{ color: "#dc2626" }}>{error}</p>}

      <h2>Recent Incidents</h2>
      {incidents.length === 0 && <p style={{ color: "#999" }}>No incidents yet.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {incidents.map((i) => (
          <li key={i.incidentId} style={{ padding: "0.5rem 0", borderBottom: "1px solid #eee" }}>
            <a href={`/incidents/${i.incidentId}`} style={{ color: "#2563eb", textDecoration: "none" }}>
              {i.incidentId}
            </a>
            <span style={{ marginLeft: 8, fontSize: "0.85rem", color: "#888" }}>{i.status}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

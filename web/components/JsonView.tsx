"use client";
import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// Tiny JSON highlighter — no dependency, no dangerouslySetInnerHTML.
function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of json.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(json.slice(last, i));
    if (m[1]) {
      out.push(<span key={key++} className={m[2] ? "j-key" : "j-str"}>{m[1]}</span>);
      if (m[2]) out.push(m[2]);
    } else {
      out.push(<span key={key++} className={m[3] ? "j-lit" : "j-num"}>{m[0]}</span>);
    }
    last = i + m[0].length;
  }
  out.push(json.slice(last));
  return out;
}

export function JsonView({ value, empty = "No data yet" }: { value: unknown; empty?: string }) {
  const [copied, setCopied] = useState(false);
  if (value === undefined) return <div className="json-empty">{empty}</div>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="json">
      <button
        className="icon-btn json-copy"
        title="Copy JSON"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
      <pre>{highlight(text)}</pre>
    </div>
  );
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Polls `fn` every `intervalMs` while the tab is visible. `refresh()` fetches immediately,
// even when polling is disabled (used for the "one last fetch" after a run finishes).
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [lastOkAt, setLastOkAt] = useState<number>();
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  const run = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(undefined);
      setLastOkAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") await run();
      if (!stop) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, run]);

  return { data, error, lastOkAt, refresh: run };
}

// Re-renders every `ms` while `active`, so running durations and countdowns tick live.
export function useNow(active: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

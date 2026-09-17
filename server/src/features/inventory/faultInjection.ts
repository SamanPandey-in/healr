import { env } from "../../config/env";

// Sleep helper — used for the latency fault mode.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Called at the top of the inventory handler on every request.
// - FAULT_MODE=error: throws ~FAULT_PROBABILITY of the time (handler's
//   existing try/catch turns this into a 500 automatically).
// - FAULT_MODE=latency: sleeps an extra 2–4s ~FAULT_PROBABILITY of the time,
//   enough to trip a latency-based CloudWatch alarm without timing out
//   (handler timeout is 10s).
export async function maybeInjectFault(): Promise<void> {
  if (!env.injectFault) return;
  if (Math.random() >= env.faultProbability) return;

  if (env.faultMode === "latency") {
    await sleep(2000 + Math.random() * 2000);
    return;
  }
  // default: error
  throw new Error("SIMULATED_FAULT: inventory dependency unavailable");
}
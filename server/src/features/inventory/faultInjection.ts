import { env } from "../../config/env";

// Sleep helper — used for the latency fault mode.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The handler's own try/catch swallows the thrown error into a normal 500
// response, so the Lambda invocation itself never registers as a failure —
// AWS Lambda's built-in "Errors" metric (unhandled exceptions/timeouts only)
// will NOT see this. Emit our own metric via CloudWatch Embedded Metric
// Format (EMF): a structured console.log line that CloudWatch Logs
// automatically extracts into a real custom metric, no extra IAM permission
// needed beyond the CloudWatch Logs write access Lambda already has.
// Verify this EMF shape against the current AWS docs if it doesn't show up
// as a metric after a test run — the spec has had minor revisions over time.
function emitFaultMetric(mode: "error" | "latency"): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "SelfHealingInfra/Inventory",
            Dimensions: [[]],
            Metrics: [{ Name: "InjectedFault", Unit: "Count" }],
          },
        ],
      },
      InjectedFault: 1,
      faultMode: mode,
    })
  );
}

// Called at the top of the inventory handler on every request.
// - FAULT_MODE=error: throws ~FAULT_PROBABILITY of the time (handler's
//   existing try/catch turns this into a 500 automatically — this no longer
//   trips a Lambda-Errors-based alarm, see emitFaultMetric above).
// - FAULT_MODE=latency: sleeps an extra 2–4s ~FAULT_PROBABILITY of the time,
//   enough to trip a latency-based CloudWatch alarm without timing out
//   (handler timeout is 10s).
export async function maybeInjectFault(): Promise<void> {
  if (!env.injectFault) return;
  if (Math.random() >= env.faultProbability) return;

  if (env.faultMode === "latency") {
    emitFaultMetric("latency");
    await sleep(2000 + Math.random() * 2000);
    return;
  }
  // default: error
  emitFaultMetric("error");
  throw new Error("SIMULATED_FAULT: inventory dependency unavailable");
}
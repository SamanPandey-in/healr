import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveVerification } from "../incidents/incidentsRepository";
import { RemediationResult, VerificationResult } from "../types";

patchAwsSdkForTracing();
const cw = new CloudWatchClient({});
const WINDOW_MINUTES = 5;

async function faultCountInWindow(startIso: string, endIso: string): Promise<number> {
  const res = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(startIso),
    EndTime: new Date(endIso),
    MetricDataQueries: [{
      Id: "faults",
      MetricStat: {
        Metric: { Namespace: "SelfHealingInfra/Inventory", MetricName: "InjectedFault" },
        Period: WINDOW_MINUTES * 60,
        Stat: "Sum",
      },
      ReturnData: true,
    }],
  }));
  const values = res.MetricDataResults?.[0]?.Values ?? [];
  return values.reduce((sum, v) => sum + v, 0);
}

export async function handler(input: RemediationResult): Promise<VerificationResult> {
  const beforeStart = new Date(new Date(input.remediatedAt).getTime() - WINDOW_MINUTES * 60_000).toISOString();
  const afterEnd = new Date().toISOString();

  const [faultCountBefore, faultCountAfter] = await Promise.all([
    faultCountInWindow(beforeStart, input.remediatedAt),
    faultCountInWindow(input.remediatedAt, afterEnd),
  ]);

  const result: VerificationResult = {
    incidentId: input.incidentId,
    service: input.service,
    faultCountBefore,
    faultCountAfter,
    recovered: faultCountAfter === 0,
    verifiedAt: new Date().toISOString(),
  };
  await saveVerification(result);
  return result;
}

import { LocalizationCandidate } from "../types";

export interface Evidence {
  id: string;
  text: string;
}

export function buildEvidence(alarmName: string, candidates: LocalizationCandidate[]): Evidence[] {
  const evidence: Evidence[] = [
    { id: "EVIDENCE#ALARM#" + alarmName, text: "CloudWatch alarm '" + alarmName + "' entered ALARM state." },
  ];
  for (const c of candidates) {
    evidence.push({
      id: "EVIDENCE#GRAPH#" + c.service,
      text: "'" + c.service + "' is " + c.distanceFromAnomaly + " call-hop(s) upstream of the alarming service in the current ServiceGraph.",
    });
    if (c.deployVersion) {
      evidence.push({
        id: "EVIDENCE#DEPLOY#" + c.service + "#" + c.deployVersion,
        text: "'" + c.service + "' deployed version " + c.deployVersion + " at " + c.deployTimestamp + ", " + c.secondsBeforeAnomaly + "s before the alarm. Diff: " + (c.deploySummary ?? "n/a") + ".",
      });
    }
  }
  return evidence;
}

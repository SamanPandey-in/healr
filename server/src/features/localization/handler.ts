import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getAllEdges } from "../graph/graphRepository";
import { getLatestDeployBefore } from "../deploy-events/deployEventsRepository";
import { saveLocalizationResult } from "../incidents/incidentsRepository";
import { findUpstreamAncestors, combinedScore } from "./heuristics";
import { LocalizationInput } from "./types";
import { LocalizationCandidate, LocalizationResult, ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(input: LocalizationInput): Promise<LocalizationResult> {
  const edges = await getAllEdges();
  const ancestors = findUpstreamAncestors(input.service as ServiceName, edges);

  const candidates: LocalizationCandidate[] = await Promise.all(
    [...ancestors.entries()].map(async ([service, distance]) => {
      const deploy = await getLatestDeployBefore(service as ServiceName, input.detectedAt);
      const secondsBeforeAnomaly = deploy
        ? (new Date(input.detectedAt).getTime() - new Date(deploy.timestamp).getTime()) / 1000
        : null;
      return {
        service: service as ServiceName,
        distanceFromAnomaly: distance,
        deployTimestamp: deploy?.timestamp ?? null,
        deployVersion: deploy?.version ?? null,
        deploySummary: deploy?.diffSummary ?? null,
        secondsBeforeAnomaly,
        score: combinedScore(secondsBeforeAnomaly, distance),
      };
    })
  );

  candidates.sort((a, b) => b.score - a.score);

  const result: LocalizationResult = {
    incidentId: input.incidentId,
    rankedCandidates: candidates,
    computedAt: new Date().toISOString(),
  };
  await saveLocalizationResult(result);
  return result;
}
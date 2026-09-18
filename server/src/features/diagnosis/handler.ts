import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { converseText } from "../../shared/aws/bedrockClient";
import { buildEvidence } from "./evidenceBuilder";
import { buildDiagnosisSchema } from "./schema";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { getIncident, saveDiagnosis } from "../incidents/incidentsRepository";
import { LocalizationResult, DiagnosisResult, ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();

function parseModelJson(raw: string): any {
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

export async function handler(input: LocalizationResult): Promise<DiagnosisResult> {
  const incident = await getIncident(input.incidentId);
  const alarmName = (incident?.alarmName as string) ?? "unknown-alarm";

  const evidence = buildEvidence(alarmName, input.rankedCandidates);
  const allowedIds = new Set(evidence.map((e) => e.id));
  const serviceNames = Array.from(new Set(input.rankedCandidates.map((c) => c.service)));

  const { text } = await converseText(
    SYSTEM_PROMPT,
    buildUserPrompt(evidence),
    buildDiagnosisSchema(evidence, serviceNames)
  );
  const parsed = parseModelJson(text);

  const rawCitations: string[] = Array.isArray(parsed.citedEvidenceIds) ? parsed.citedEvidenceIds : [];
  const validCitations = rawCitations.filter((id) => allowedIds.has(id));

  if (validCitations.length === 0) {
    throw new Error(
      `DIAGNOSIS_NOT_GROUNDED: model returned ${rawCitations.length} citation(s), 0 matched known evidence ids`
    );
  }

  const result: DiagnosisResult = {
    incidentId: input.incidentId,
    rootCauseService: parsed.rootCauseService as ServiceName,
    summary: String(parsed.summary ?? ""),
    citedEvidenceIds: validCitations,
    confidence: Number(parsed.confidence ?? 0),
    rankedCandidates: input.rankedCandidates,
    generatedAt: new Date().toISOString(),
  };
  await saveDiagnosis(result);
  return result;
}

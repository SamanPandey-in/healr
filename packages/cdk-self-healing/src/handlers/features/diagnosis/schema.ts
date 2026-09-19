import { Evidence } from "./evidenceBuilder";
import { ServiceName } from "../types";

export function buildDiagnosisSchema(evidence: Evidence[], serviceNames: ServiceName[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rootCauseService", "confidence", "summary", "citedEvidenceIds"],
    properties: {
      rootCauseService: { type: "string", enum: serviceNames },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string" },
      citedEvidenceIds: {
        type: "array",
        items: { type: "string", enum: evidence.map((e) => e.id) },
        minItems: 1,
      },
    },
  };
}

import { traced } from "../aws/xray";

const MODEL_ID = process.env.GEMINI_MODEL_ID ?? "gemini-2.5-flash";
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

export interface ConverseTextResult {
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function stripAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAdditionalProperties);
  if (node && typeof node === "object") {
    const { additionalProperties, ...rest } = node as Record<string, unknown>;
    for (const key of Object.keys(rest)) rest[key] = stripAdditionalProperties(rest[key]);
    return rest;
  }
  return node;
}

export async function converseText(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: Record<string, unknown>
): Promise<ConverseTextResult> {
  if (!API_KEY) throw new Error("Missing required env var: GEMINI_API_KEY");

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      ...(jsonSchema
        ? { responseMimeType: "application/json", responseSchema: stripAdditionalProperties(jsonSchema) }
        : {}),
    },
  };

  return traced("gemini.converseText", async () => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY! },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("");

    return {
      text,
      stopReason: candidate?.finishReason,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    };
  });
}

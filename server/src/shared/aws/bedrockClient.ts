import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import AWSXRay from "aws-xray-sdk-core";

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "qwen.qwen3-235b-a22b-2507-v1:0";

const client = new BedrockRuntimeClient({});
AWSXRay.captureAWSv3Client(client as any);

export interface ConverseTextResult {
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function converseText(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: Record<string, unknown>
): Promise<ConverseTextResult> {
  const response = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: "user", content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
      ...(jsonSchema
        ? {
            outputConfig: {
              textFormat: {
                type: "json_schema",
                structure: { jsonSchema: { name: "diagnosis", schema: jsonSchema, strict: true } },
              },
            } as any,
          }
        : {}),
    })
  );

  const content = response.output?.message?.content ?? [];
  const block = content.find((b) => b && "text" in b);
  const text = block && "text" in block ? (block.text ?? "") : "";
  return {
    text,
    stopReason: response.stopReason,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  };
}

import { IFunction } from "aws-cdk-lib/aws-lambda";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Stack } from "aws-cdk-lib";
import { Construct } from "constructs";

export const DEFAULT_BEDROCK_MODEL_ID = "qwen.qwen3-235b-a22b-2507-v1:0";

export function grantBedrockInvoke(scope: Construct, fn: IFunction, modelId = DEFAULT_BEDROCK_MODEL_ID) {
  const region = Stack.of(scope).region;
  fn.addToRolePolicy(new PolicyStatement({
    sid: "GrantQwenInRegionModelInvoke",
    actions: ["bedrock:InvokeModel"],
    resources: [`arn:aws:bedrock:${region}::foundation-model/${modelId}`],
  }));
}

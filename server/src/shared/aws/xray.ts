import AWSXRay from "aws-xray-sdk-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export function patchAwsSdkForTracing() {
  AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
}

export async function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const segment = AWSXRay.getSegment();
  const subsegment = segment?.addNewSubsegment(name);
  try {
    return await fn();
  } catch (err) {
    subsegment?.addError(err as Error);
    throw err;
  } finally {
    subsegment?.close();
  }
}
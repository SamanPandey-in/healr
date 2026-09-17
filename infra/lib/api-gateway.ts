import { RestApi, LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import { IFunction } from "aws-cdk-lib/aws-lambda";

export function createApi(scope: Construct, gatewayFn: IFunction) {
  const api = new RestApi(scope, "PublicApi", {
    restApiName: "self-healing-infra-api",
    deployOptions: { tracingEnabled: true },
  });

  const orders = api.root.addResource("orders");
  orders.addMethod("POST", new LambdaIntegration(gatewayFn));

  return api;
}
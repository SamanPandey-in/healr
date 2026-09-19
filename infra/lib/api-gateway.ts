import { RestApi, LambdaIntegration, Cors } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import { IFunction } from "aws-cdk-lib/aws-lambda";

export function createApi(scope: Construct, gatewayFn: IFunction, armDemoFn: IFunction,
                           getIncidentFn: IFunction, listIncidentsFn: IFunction) {
  const api = new RestApi(scope, "PublicApi", {
    restApiName: "self-healing-infra-api",
    deployOptions: { tracingEnabled: true },
    defaultCorsPreflightOptions: {
      allowOrigins: ["https://builds.samanp.xyz", "http://localhost:3000"],
      allowMethods: Cors.ALL_METHODS,
    },
  });

  const orders = api.root.addResource("orders");
  orders.addMethod("POST", new LambdaIntegration(gatewayFn));

  const demo = api.root.addResource("demo");
  demo.addResource("arm").addMethod("POST", new LambdaIntegration(armDemoFn));

  const incidents = api.root.addResource("incidents");
  incidents.addMethod("GET", new LambdaIntegration(listIncidentsFn));
  incidents.addResource("{id}").addMethod("GET", new LambdaIntegration(getIncidentFn));

  return api;
}
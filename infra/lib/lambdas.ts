import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, Tracing, FunctionUrlAuthType, Alias } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { requireGeminiApiKey, DEFAULT_GEMINI_MODEL_ID } from "./geminiAccess";

interface LambdasProps {
  serviceGraph: Table;
  deployEvents: Table;
  incidents: Table;
}

const geminiApiKey = requireGeminiApiKey();
const geminiModelId = process.env.GEMINI_MODEL_ID ?? DEFAULT_GEMINI_MODEL_ID;

export function createLambdas(scope: Construct, tables: LambdasProps) {
  const commonEnv = {
    SERVICE_GRAPH_TABLE: tables.serviceGraph.tableName,
    DEPLOY_EVENTS_TABLE: tables.deployEvents.tableName,
    INCIDENTS_TABLE: tables.incidents.tableName,
  };
  const xrayBundling = { nodeModules: ["aws-xray-sdk-core"] };

  const inventoryFn = new NodejsFunction(scope, "InventoryFunction", {
    entry: "../server/src/features/inventory/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INJECT_FAULT: "true", FAULT_PROBABILITY: "0.3", FAULT_MODE: "error" },
    bundling: xrayBundling,
  });

  const inventoryVersion = inventoryFn.currentVersion;
  inventoryVersion.applyRemovalPolicy(RemovalPolicy.RETAIN);

  const inventoryAlias = new Alias(scope, "InventoryLiveAlias", {
    aliasName: "live",
    version: inventoryVersion,
  });
  const inventoryUrl = inventoryAlias.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

  const ordersFn = new NodejsFunction(scope, "OrdersFunction", {
    entry: "../server/src/features/orders/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INVENTORY_FUNCTION_URL: inventoryUrl.url },
    bundling: xrayBundling,
  });
  const ordersUrl = ordersFn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

  const gatewayFn = new NodejsFunction(scope, "GatewayFunction", {
    entry: "../server/src/features/gateway/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, ORDERS_FUNCTION_URL: ordersUrl.url },
    bundling: xrayBundling,
  });

  const deployEventsWebhookFn = new NodejsFunction(scope, "DeployEventsWebhookFunction", {
    entry: "../server/src/features/deploy-events/webhookHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

  const createIncidentFn = new NodejsFunction(scope, "CreateIncidentFunction", {
    entry: "../server/src/features/incidents/createIncidentHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

  const buildGraphFn = new NodejsFunction(scope, "BuildGraphFunction", {
    entry: "../server/src/features/graph/buildGraphHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(30),
    environment: commonEnv,
    bundling: xrayBundling,
  });

  const localizeFn = new NodejsFunction(scope, "LocalizeRootCauseFunction", {
    entry: "../server/src/features/localization/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

  // ---------------------------------------------------------------- Day 3

  const diagnoseFn = new NodejsFunction(scope, "DiagnoseWithBedrockFunction", {
    entry: "../server/src/features/diagnosis/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(60),
    environment: { ...commonEnv, GEMINI_API_KEY: geminiApiKey, GEMINI_MODEL_ID: geminiModelId },
    bundling: xrayBundling,
  });

  const approveHandlerFn = new NodejsFunction(scope, "ApproveHandlerFunction", {
    entry: "../server/src/features/approval/approveHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });
  const approveHandlerUrl = approveHandlerFn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
  approveHandlerFn.addToRolePolicy(new PolicyStatement({
    actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
    resources: ["*"],
  }));

  const requestApprovalFn = new NodejsFunction(scope, "RequestApprovalFunction", {
    entry: "../server/src/features/approval/requestApprovalHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: { ...commonEnv, APPROVE_FUNCTION_URL: approveHandlerUrl.url },
    bundling: xrayBundling,
  });

  const remediateFn = new NodejsFunction(scope, "RemediateFunction", {
    entry: "../server/src/features/remediation/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: {
      ...commonEnv,
      INVENTORY_FUNCTION_NAME: inventoryFn.functionName,
      INVENTORY_ALIAS_NAME: inventoryAlias.aliasName,
    },
    bundling: xrayBundling,
  });
  remediateFn.addToRolePolicy(new PolicyStatement({
    actions: ["lambda:GetAlias", "lambda:UpdateAlias", "lambda:ListVersionsByFunction"],
    resources: [inventoryFn.functionArn, `${inventoryFn.functionArn}:*`],
  }));

  const verifyOutcomeFn = new NodejsFunction(scope, "VerifyOutcomeFunction", {
    entry: "../server/src/features/verification/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });
  verifyOutcomeFn.addToRolePolicy(new PolicyStatement({
    actions: ["cloudwatch:GetMetricData"],
    resources: ["*"],
  }));

  // ------------------------------------------------------- demo (plan5)

  const armDemoFn = new NodejsFunction(scope, "ArmDemoFunction", {
    entry: "../server/src/features/demo/armDemoHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(30),
    environment: { ...commonEnv, INVENTORY_FUNCTION_NAME: inventoryFn.functionName,
      INVENTORY_ALIAS_NAME: inventoryAlias.aliasName },
    bundling: xrayBundling,
  });
  armDemoFn.addToRolePolicy(new PolicyStatement({
    actions: ["lambda:UpdateFunctionConfiguration", "lambda:GetFunctionConfiguration",
              "lambda:PublishVersion", "lambda:UpdateAlias"],
    resources: [inventoryFn.functionArn, `${inventoryFn.functionArn}:*`],
  }));

  const getIncidentFn = new NodejsFunction(scope, "GetIncidentFunction", {
    entry: "../server/src/features/incidents/getIncidentHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

  const listIncidentsFn = new NodejsFunction(scope, "ListIncidentsFunction", {
    entry: "../server/src/features/incidents/listIncidentsHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

  // ---------------------------------------------------------- grants

  tables.serviceGraph.grantReadWriteData(gatewayFn);
  tables.deployEvents.grantReadWriteData(deployEventsWebhookFn);
  tables.incidents.grantReadWriteData(createIncidentFn);
  tables.incidents.grantReadWriteData(localizeFn);
  tables.serviceGraph.grantReadWriteData(buildGraphFn);
  tables.serviceGraph.grantReadData(localizeFn);
  tables.deployEvents.grantReadData(localizeFn);
  tables.incidents.grantReadWriteData(diagnoseFn);
  tables.incidents.grantReadWriteData(requestApprovalFn);
  tables.incidents.grantReadWriteData(approveHandlerFn);
  tables.incidents.grantReadWriteData(remediateFn);
  tables.incidents.grantReadWriteData(verifyOutcomeFn);
  tables.incidents.grantReadWriteData(armDemoFn);
  tables.incidents.grantReadData(getIncidentFn);
  tables.incidents.grantReadData(listIncidentsFn);

  buildGraphFn.addToRolePolicy(new PolicyStatement({
    actions: ["xray:GetTraceSummaries", "xray:BatchGetTraces"],
    resources: ["*"],
  }));

  return {
    gatewayFn, ordersFn, inventoryFn, deployEventsWebhookFn,
    createIncidentFn, buildGraphFn, localizeFn,
    diagnoseFn, requestApprovalFn, approveHandlerFn, remediateFn, verifyOutcomeFn,
    armDemoFn, getIncidentFn, listIncidentsFn,
    approveHandlerUrl: approveHandlerUrl.url,
  };
}

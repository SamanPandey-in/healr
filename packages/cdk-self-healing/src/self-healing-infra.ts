import * as path from "path";
import { Construct } from "constructs";
import { IFunction, Alias, Runtime, Tracing, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Table, AttributeType, BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { RestApi, LambdaIntegration, Cors } from "aws-cdk-lib/aws-apigateway";
import { Duration, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  StateMachine, DefinitionBody, JsonPath, IntegrationPattern, TaskInput, Wait, WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Rule, RuleTargetInput, EventField } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";

const HANDLER_DIR = path.join(__dirname, "..", "src", "handlers");

export interface SelfHealingInfraProps {
  /** The Lambda alias to protect. The construct wires remediation to move this alias
   *  between Lambda versions on rollback. */
  protectedAlias: Alias;
  /** Gemini API key for the diagnosis step. */
  geminiApiKey: string;
  /** Gemini model ID. Defaults to gemini-2.5-flash. */
  geminiModelId?: string;
  /** CloudWatch alarm configuration. If omitted, a default error-rate alarm is created
   *  on the protected function's InjectedFault metric. */
  alarm?: { metricNamespace: string; metricName: string; threshold: number };
}

export class SelfHealingInfra extends Construct {
  public readonly deployWebhookUrl: string;
  public readonly incidentsApiUrl: string;

  constructor(scope: Construct, id: string, props: SelfHealingInfraProps) {
    super(scope, id);

    const commonEnv = {
      GEMINI_API_KEY: props.geminiApiKey,
      GEMINI_MODEL_ID: props.geminiModelId ?? "gemini-2.5-flash",
      PROTECTED_FUNCTION_NAME: props.protectedAlias.lambda.functionName,
      PROTECTED_ALIAS_NAME: props.protectedAlias.aliasName,
    };
    const xrayBundling = { nodeModules: ["aws-xray-sdk-core"] };

    // ── Tables ───────────────────────────────────────────────────────────
    const serviceGraph = new Table(this, "ServiceGraphTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    const deployEvents = new Table(this, "DeployEventsTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    const incidents = new Table(this, "IncidentsTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    const tableEnv = {
      SERVICE_GRAPH_TABLE: serviceGraph.tableName,
      DEPLOY_EVENTS_TABLE: deployEvents.tableName,
      INCIDENTS_TABLE: incidents.tableName,
    };

    // ── Supporting Lambdas ───────────────────────────────────────────────
    const createIncidentFn = new NodejsFunction(this, "CreateIncidentFunction", {
      entry: path.join(HANDLER_DIR, "features", "incidents", "createIncidentHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const buildGraphFn = new NodejsFunction(this, "BuildGraphFunction", {
      entry: path.join(HANDLER_DIR, "features", "graph", "buildGraphHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      timeout: Duration.seconds(30),
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const localizeFn = new NodejsFunction(this, "LocalizeRootCauseFunction", {
      entry: path.join(HANDLER_DIR, "features", "localization", "handler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const diagnoseFn = new NodejsFunction(this, "DiagnoseFunction", {
      entry: path.join(HANDLER_DIR, "features", "diagnosis", "handler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      timeout: Duration.seconds(60),
      environment: { ...tableEnv, ...commonEnv },
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const approveHandlerFn = new NodejsFunction(this, "ApproveHandlerFunction", {
      entry: path.join(HANDLER_DIR, "features", "approval", "approveHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });
    const approveHandlerUrl = approveHandlerFn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    approveHandlerFn.addToRolePolicy(new PolicyStatement({
      actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
      resources: ["*"],
    }));

    const requestApprovalFn = new NodejsFunction(this, "RequestApprovalFunction", {
      entry: path.join(HANDLER_DIR, "features", "approval", "requestApprovalHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: { ...tableEnv, APPROVE_FUNCTION_URL: approveHandlerUrl.url },
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const remediateFn = new NodejsFunction(this, "RemediateFunction", {
      entry: path.join(HANDLER_DIR, "features", "remediation", "handler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: {
        ...tableEnv,
        PROTECTED_FUNCTION_NAME: props.protectedAlias.lambda.functionName,
        PROTECTED_ALIAS_NAME: props.protectedAlias.aliasName,
      },
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });
    remediateFn.addToRolePolicy(new PolicyStatement({
      actions: ["lambda:GetAlias", "lambda:UpdateAlias", "lambda:ListVersionsByFunction"],
      resources: [props.protectedAlias.lambda.functionArn, props.protectedAlias.lambda.functionArn + ":*"],
    }));

    const verifyFn = new NodejsFunction(this, "VerifyOutcomeFunction", {
      entry: path.join(HANDLER_DIR, "features", "verification", "handler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });
    verifyFn.addToRolePolicy(new PolicyStatement({
      actions: ["cloudwatch:GetMetricData"],
      resources: ["*"],
    }));

    // ── API Lambdas ──────────────────────────────────────────────────────
    const deployWebhookFn = new NodejsFunction(this, "DeployEventsWebhookFunction", {
      entry: path.join(HANDLER_DIR, "features", "deploy-events", "webhookHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const getIncidentFn = new NodejsFunction(this, "GetIncidentFunction", {
      entry: path.join(HANDLER_DIR, "features", "incidents", "getIncidentHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    const listIncidentsFn = new NodejsFunction(this, "ListIncidentsFunction", {
      entry: path.join(HANDLER_DIR, "features", "incidents", "listIncidentsHandler.ts"),
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,
      environment: tableEnv,
      bundling: xrayBundling,
      projectRoot: path.join(HANDLER_DIR, ".."),
    });

    // ── Table grants ─────────────────────────────────────────────────────
    serviceGraph.grantReadWriteData(buildGraphFn);
    serviceGraph.grantReadData(localizeFn);
    deployEvents.grantReadWriteData(deployWebhookFn);
    deployEvents.grantReadData(localizeFn);
    incidents.grantReadWriteData(createIncidentFn);
    incidents.grantReadWriteData(localizeFn);
    incidents.grantReadWriteData(diagnoseFn);
    incidents.grantReadWriteData(requestApprovalFn);
    incidents.grantReadWriteData(approveHandlerFn);
    incidents.grantReadWriteData(remediateFn);
    incidents.grantReadWriteData(verifyFn);
    incidents.grantReadData(getIncidentFn);
    incidents.grantReadData(listIncidentsFn);

    buildGraphFn.addToRolePolicy(new PolicyStatement({
      actions: ["xray:GetTraceSummaries", "xray:BatchGetTraces"],
      resources: ["*"],
    }));

    // ── API Gateway ──────────────────────────────────────────────────────
    const api = new RestApi(this, "SelfHealingApi", {
      restApiName: "self-healing-infra-api",
      deployOptions: { tracingEnabled: true },
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowMethods: Cors.ALL_METHODS,
      },
    });

    const webhook = api.root.addResource("webhook");
    webhook.addMethod("POST", new LambdaIntegration(deployWebhookFn));

    const incidentsResource = api.root.addResource("incidents");
    incidentsResource.addMethod("GET", new LambdaIntegration(listIncidentsFn));
    incidentsResource.addResource("{id}").addMethod("GET", new LambdaIntegration(getIncidentFn));

    this.deployWebhookUrl = api.urlForPath("/webhook");
    this.incidentsApiUrl = api.urlForPath("/incidents");

    // ── State Machine ────────────────────────────────────────────────────
    const createIncident = new LambdaInvoke(this, "SFN_CreateIncident", {
      lambdaFunction: createIncidentFn,
      payloadResponseOnly: true,
    });
    const buildGraph = new LambdaInvoke(this, "SFN_BuildGraph", {
      lambdaFunction: buildGraphFn,
      payloadResponseOnly: true,
    });
    const localize = new LambdaInvoke(this, "SFN_Localize", {
      lambdaFunction: localizeFn,
      payloadResponseOnly: true,
    });
    const diagnose = new LambdaInvoke(this, "SFN_Diagnose", {
      lambdaFunction: diagnoseFn,
      payloadResponseOnly: true,
    });
    const requestApproval = new LambdaInvoke(this, "SFN_RequestApproval", {
      lambdaFunction: requestApprovalFn,
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: TaskInput.fromObject({
        taskToken: JsonPath.taskToken,
        diagnosis: JsonPath.entirePayload,
      }),
      taskTimeout: { seconds: Duration.minutes(30).toSeconds() } as any,
    });
    const remediate = new LambdaInvoke(this, "SFN_Remediate", {
      lambdaFunction: remediateFn,
      payloadResponseOnly: true,
    });
    const settle = new Wait(this, "SFN_WaitForMetrics", {
      time: WaitTime.duration(Duration.seconds(60)),
    });
    const verify = new LambdaInvoke(this, "SFN_Verify", {
      lambdaFunction: verifyFn,
      payloadResponseOnly: true,
    });

    const definition = createIncident
      .next(buildGraph)
      .next(localize)
      .next(diagnose)
      .next(requestApproval)
      .next(remediate)
      .next(settle)
      .next(verify);

    const stateMachine = new StateMachine(this, "IncidentStateMachine", {
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(40),
    });

    // ── Alarm ────────────────────────────────────────────────────────────
    const alarmConfig = props.alarm ?? {
      metricNamespace: "SelfHealingInfra/Inventory",
      metricName: "InjectedFault",
      threshold: 1,
    };

    const alarm = new Alarm(this, "ProtectedFunctionAlarm", {
      metric: new Metric({
        namespace: alarmConfig.metricNamespace,
        metricName: alarmConfig.metricName,
        statistic: "Sum",
        period: Duration.minutes(1),
      }),
      threshold: alarmConfig.threshold,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const alarmRule = new Rule(this, "AlarmToStateMachine", {
      eventPattern: {
        source: ["aws.cloudwatch"],
        detailType: ["CloudWatch Alarm State Change"],
        detail: {
          alarmName: [alarm.alarmName],
          state: { value: ["ALARM"] },
        },
      },
    });

    alarmRule.addTarget(
      new SfnStateMachine(stateMachine, {
        input: RuleTargetInput.fromObject({
          service: props.protectedAlias.aliasName,
          alarmName: alarm.alarmName,
          detectedAt: EventField.fromPath("$.time"),
        }),
      })
    );

    // ── Outputs ──────────────────────────────────────────────────────────
    new CfnOutput(this, "DeployWebhookUrl", { value: this.deployWebhookUrl });
    new CfnOutput(this, "IncidentsApiUrl", { value: this.incidentsApiUrl });
    new CfnOutput(this, "ApproveFunctionUrl", { value: approveHandlerUrl.url });
  }
}

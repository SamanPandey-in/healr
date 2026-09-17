import { Construct } from "constructs";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Rule, RuleTargetInput, EventField } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { StateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Duration } from "aws-cdk-lib";

export function createInventoryAlarmAndRule(
  scope: Construct,
  inventoryFn: IFunction,
  stateMachine: StateMachine
) {
  const errorAlarm = new Alarm(scope, "InventoryErrorAlarm", {
    metric: inventoryFn.metricErrors({ period: Duration.minutes(1) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING,
    alarmName: "InventoryErrorAlarm",
  });

  // Use RuleTargetInput.fromPath to thread the actual alarm-trigger time through
  const rule = new Rule(scope, "InventoryAlarmToStepFunctions", {
    eventPattern: {
      source: ["aws.cloudwatch"],
      detailType: ["CloudWatch Alarm State Change"],
      detail: {
        alarmName: [errorAlarm.alarmName],
        state: { value: ["ALARM"] },
      },
    },
  });

  // FIX: Use EventField.fromPath("$.time") to capture the real alarm state-change
  // timestamp instead of synth-time "now". This ensures the temporal heuristic in
  // LocalizeRootCause gets an accurate detectedAt for scoring deploy proximity.
  rule.addTarget(
    new SfnStateMachine(stateMachine, {
      input: RuleTargetInput.fromObject({
        service: "inventory",
        alarmName: errorAlarm.alarmName,
        detectedAt: EventField.fromPath("$.time"),
      }),
    })
  );

  return { errorAlarm, rule };
}
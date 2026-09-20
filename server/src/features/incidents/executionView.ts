import type { DescribeExecutionCommandOutput, HistoryEvent } from "@aws-sdk/client-sfn";

// What the dashboard receives. Deliberately plain JSON (no Dates, no SDK types).
export type StepStatus = "running" | "waiting" | "succeeded" | "failed";

export interface StepView {
  name: string;
  status: StepStatus;
  enteredAt: string;
  exitedAt?: string;
  durationMs?: number;
  attempts: number; // >1 means the state's Retry policy kicked in
  waitingOn?: "callback" | "timer";
  input?: unknown;
  output?: unknown;
  error?: string;
  cause?: string;
}

export interface EventView {
  id: number;
  type: string;
  timestamp: string;
  state?: string;
}

export interface ExecutionView {
  executionArn: string;
  name?: string;
  status: string;
  startDate: string;
  stopDate?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  consoleUrl: string;
  steps: StepView[];
  events: EventView[];
}

const MAX_PAYLOAD_CHARS = 20_000;

// The task token is a bearer secret for SendTaskSuccess — never ship it to a browser
// through the execution view. (The approval link is served separately from DynamoDB.)
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === "taskToken" ? "[redacted]" : redact(v),
      ])
    );
  }
  return value;
}

export function parsePayload(raw?: string): unknown {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  const safe = redact(parsed);
  const text = JSON.stringify(safe);
  if (text && text.length > MAX_PAYLOAD_CHARS) {
    return { _truncated: true, preview: text.slice(0, MAX_PAYLOAD_CHARS) };
  }
  return safe;
}

function isFailureType(type: string): boolean {
  return type.endsWith("Failed") || type.endsWith("TimedOut") || type === "ExecutionAborted";
}

function failureDetails(ev: HistoryEvent): { error?: string; cause?: string } | undefined {
  return (
    (ev as any).lambdaFunctionFailedEventDetails ??
    (ev as any).taskFailedEventDetails ??
    (ev as any).lambdaFunctionTimedOutEventDetails ??
    (ev as any).taskTimedOutEventDetails ??
    (ev as any).taskSubmitFailedEventDetails ??
    (ev as any).executionFailedEventDetails ??
    (ev as any).executionTimedOutEventDetails ??
    (ev as any).executionAbortedEventDetails
  );
}

// Turns Step Functions' flat event list into one row per state.
export function buildSteps(events: HistoryEvent[]): StepView[] {
  const steps: StepView[] = [];
  let current: StepView | undefined;

  for (const ev of events) {
    const type = String((ev as any).type ?? "");
    const ts = (ev as any).timestamp?.toISOString();
    if (!ts) continue;

    if ((ev as any).stateEnteredEventDetails?.name) {
      current = {
        name: (ev as any).stateEnteredEventDetails.name,
        status: "running",
        enteredAt: ts,
        attempts: 0,
        input: parsePayload((ev as any).stateEnteredEventDetails.input),
      };
      if (type === "WaitStateEntered") current.waitingOn = "timer";
      steps.push(current);
      continue;
    }

    if ((ev as any).stateExitedEventDetails?.name) {
      const step = [...steps].reverse().find((s) => s.name === (ev as any).stateExitedEventDetails!.name && !s.exitedAt);
      if (step) {
        step.status = "succeeded";
        step.exitedAt = ts;
        step.durationMs = Date.parse(ts) - Date.parse(step.enteredAt);
        step.output = parsePayload((ev as any).stateExitedEventDetails.output);
        step.waitingOn = undefined;
      }
      continue;
    }

    if (!current) continue;

    // A (re)scheduled attempt — covers plain Lambda tasks and the callback pattern.
    if (type === "LambdaFunctionScheduled" || type === "TaskScheduled") {
      current.attempts += 1;
      if (current.attempts > 1) {
        current.status = "running";
        current.exitedAt = undefined;
      }
    } else if (type === "TaskSubmitted") {
      current.waitingOn = "callback"; // Lambda returned; SFN now waits for SendTaskSuccess/Failure
    } else if (isFailureType(type)) {
      const d = failureDetails(ev);
      current.status = "failed";
      current.exitedAt = ts;
      current.durationMs = Date.parse(ts) - Date.parse(current.enteredAt);
      current.error = d?.error;
      current.cause = d?.cause;
      current.waitingOn = undefined;
    }
  }

  for (const s of steps) {
    if (s.status === "running" && s.waitingOn) s.status = "waiting";
  }
  return steps;
}

export function buildEvents(events: HistoryEvent[]): EventView[] {
  let state: string | undefined;
  return events.map((ev) => {
    let label = state;
    if ((ev as any).stateEnteredEventDetails?.name) {
      state = (ev as any).stateEnteredEventDetails.name;
      label = state;
    } else if ((ev as any).stateExitedEventDetails?.name) {
      label = (ev as any).stateExitedEventDetails.name;
      state = undefined;
    }
    return {
      id: (ev as any).id ?? 0,
      type: String((ev as any).type ?? "Unknown"),
      timestamp: (ev as any).timestamp?.toISOString() ?? "",
      state: label,
    };
  });
}

export function buildExecutionView(
  desc: DescribeExecutionCommandOutput,
  events: HistoryEvent[],
  region: string
): ExecutionView {
  const arn = (desc as any).executionArn ?? "";
  return {
    executionArn: arn,
    name: (desc as any).name,
    status: String((desc as any).status ?? "UNKNOWN"),
    startDate: (desc as any).startDate?.toISOString() ?? "",
    stopDate: (desc as any).stopDate?.toISOString(),
    durationMs: (desc as any).startDate && (desc as any).stopDate ? (desc as any).stopDate.getTime() - (desc as any).startDate.getTime() : undefined,
    input: parsePayload((desc as any).input),
    output: parsePayload((desc as any).output),
    // Best-effort deep link into the Step Functions console (format not verified — see plan §12).
    consoleUrl: `https://${region}.console.aws.amazon.com/states/home?region=${region}#/v2/executions/details/${arn}`,
    steps: buildSteps(events),
    events: buildEvents(events),
  };
}

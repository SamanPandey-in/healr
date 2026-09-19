export async function recordDeploy(
  webhookUrl: string,
  event: { service: string; version: string; deployedAt?: string }
): Promise<void> {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...event,
      deployedAt: event.deployedAt ?? new Date().toISOString(),
      diffSummary: "",
    }),
  });
}

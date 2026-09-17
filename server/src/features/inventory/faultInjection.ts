import { env } from "../../config/env";

export async function maybeInjectFault(): Promise<void> {
  if (!env.injectFault) return;
}
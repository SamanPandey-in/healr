export function requireGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing GEMINI_API_KEY in the environment running `cdk deploy`/`cdk synth`. " +
      'Export it first, e.g.: export GEMINI_API_KEY="your-key-here" (see docs/plan4-gemini-migration.md §5).'
    );
  }
  return key;
}

export const DEFAULT_GEMINI_MODEL_ID = "gemini-2.5-flash";

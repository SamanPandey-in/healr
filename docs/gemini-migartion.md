# plan4-gemini-migration.md — Swap Bedrock → Gemini for `DiagnoseWithBedrockFunction` only

**Why:** Bedrock model access isn't available on this AWS account right now (account-level
config issue, not a code issue). Rather than block on that, this plan re-points the single
call site that talks to Bedrock — inside the Day 3 `DiagnoseWithBedrockFunction` — at the
Gemini API instead. Everything from Day 1 and Day 2 (tables, gateway/orders/inventory,
X-Ray, the `InventoryErrorAlarm` → Step Functions trigger, `CreateIncident → BuildGraph →
LocalizeRootCause`) is untouched. Day 3's other pieces (`RequestApproval`, `Remediate`,
`VerifyOutcome`) are also untouched — they don't call an LLM at all.

**I am not fully certain about two things below and have flagged them inline where they come
up: (1) the exact Gemini model id you should default to, since Google's lineup moves fast and
my knowledge may be stale; (2) the Lambda Node 20.x runtime shipping global `fetch` without a
polyfill — very likely true, but worth a quick smoke test rather than taking on faith.**

---

## 0. Blast-radius check — what this touches and what it doesn't

| Touches | Does NOT touch |
|---|---|
| `server/src/features/diagnosis/handler.ts` (1 import line) | `localization/`, `incidents/`, `remediation/`, `verification/`, `approval/`, `orders/`, `inventory/`, `gateway/` — zero changes |
| `infra/lib/lambdas.ts` (`diagnoseFn` block only) | `infra/lib/tables.ts`, `alarms.ts`, `step-functions.ts`, `api-gateway.ts` — zero changes |
| New file: `server/src/shared/llm/geminiClient.ts` | `server/src/shared/aws/bedrockClient.ts` — left in place, untouched, for instant rollback |
| New file: `infra/lib/geminiAccess.ts` (env-var validation) | `infra/lib/bedrockAccess.ts` — left in place, untouched |
| `diagnosis/schema.ts`, `prompt.ts`, `evidenceBuilder.ts` | not touched — same evidence, same prompt, same JSON-Schema shape |

The `converseText(systemPrompt, userPrompt, jsonSchema)` function signature is preserved
exactly, so the diagnosis handler's logic (grounding check, citation validation, DynamoDB
write) doesn't change at all — only which file it imports `converseText` from.

---

## 1. New file — `server/src/shared/llm/geminiClient.ts`

Create the directory and file:

```bash
mkdir -p server/src/shared/llm
```

```ts
// server/src/shared/llm/geminiClient.ts
import { traced } from "../aws/xray";

// I am not fully certain "gemini-3.1-flash-lite" is still the best default as of when you're
// reading this — Google's Gemini lineup has moved quickly. Check https://ai.google.dev/gemini-api/docs/models
// and override with GEMINI_MODEL_ID if a newer/cheaper model fits better.
const MODEL_ID = process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

export interface ConverseTextResult {
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

// Gemini's responseSchema doesn't accept the JSON-Schema `additionalProperties` keyword the
// way Bedrock's Structured Outputs did — strip it recursively so buildDiagnosisSchema() in
// schema.ts can be reused completely unchanged.
function stripAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAdditionalProperties);
  if (node && typeof node === "object") {
    const { additionalProperties, ...rest } = node as Record<string, unknown>;
    for (const key of Object.keys(rest)) rest[key] = stripAdditionalProperties(rest[key]);
    return rest;
  }
  return node;
}

export async function converseText(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: Record<string, unknown>
): Promise<ConverseTextResult> {
  if (!API_KEY) throw new Error("Missing required env var: GEMINI_API_KEY");

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      ...(jsonSchema
        ? { responseMimeType: "application/json", responseSchema: stripAdditionalProperties(jsonSchema) }
        : {}),
    },
  };

  return traced("gemini.converseText", async () => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY! },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("");

    return {
      text,
      stopReason: candidate?.finishReason,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    };
  });
}
```

Notes:
- Uses the Lambda runtime's built-in global `fetch` (Node 18+ ships it unflagged) — no new
  npm dependency, so `server/package.json` needs **no changes**. Do a real test invoke after
  deploying rather than trusting this blind — see §6.
- `traced(...)` is the existing X-Ray helper from `shared/aws/xray.ts` (already used elsewhere
  in the codebase), so the Gemini call gets its own subsegment the same way the Bedrock call
  implicitly did via `AWSXRay.captureAWSv3Client`.
- `parseModelJson` in `diagnosis/handler.ts` already strips ```` ```json ```` fences, so Gemini's
  response (with `responseMimeType: "application/json"` it shouldn't add fences, but the
  strip is harmless either way) needs no handler-side change.

---

## 2. One-line change — `server/src/features/diagnosis/handler.ts`

```diff
- import { converseText } from "../../shared/aws/bedrockClient";
+ import { converseText } from "../../shared/llm/geminiClient";
```

Nothing else in this file changes. The grounding check (`citedEvidenceIds` must overlap
`allowedIds`) and the `DIAGNOSIS_NOT_GROUNDED` failure path stay exactly as they are — this
is Bedrock/Gemini-agnostic defense-in-depth and should be preserved regardless of provider.

---

## 3. New file — `infra/lib/geminiAccess.ts`

Fail fast at `cdk synth`/`cdk deploy` time (not mid-incident in a Lambda) if the key isn't
set, mirroring the `required()` pattern already used in `server/src/config/env.ts`:

```ts
// infra/lib/geminiAccess.ts
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

export const DEFAULT_GEMINI_MODEL_ID = "gemini-3.1-flash-lite";
```

---

## 4. Edit — `infra/lib/lambdas.ts`

**Import swap** (top of file):

```diff
- import { grantBedrockInvoke, DEFAULT_BEDROCK_MODEL_ID } from "./bedrockAccess";
+ import { requireGeminiApiKey, DEFAULT_GEMINI_MODEL_ID } from "./geminiAccess";
```

**Read the key once, at module scope, before any construct is created** — this is what makes
it fail before touching CloudFormation rather than partway through a deploy:

```diff
+ const geminiApiKey = requireGeminiApiKey();
+ const geminiModelId = process.env.GEMINI_MODEL_ID ?? DEFAULT_GEMINI_MODEL_ID;
+
  export function createLambdas(scope: Construct, tables: LambdasProps) {
```

**`diagnoseFn` block** — replace the Bedrock env var and drop the IAM grant:

```diff
  const diagnoseFn = new NodejsFunction(scope, "DiagnoseWithBedrockFunction", {
    entry: "../server/src/features/diagnosis/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(60),
-   environment: { ...commonEnv, BEDROCK_MODEL_ID: DEFAULT_BEDROCK_MODEL_ID },
+   environment: { ...commonEnv, GEMINI_API_KEY: geminiApiKey, GEMINI_MODEL_ID: geminiModelId },
    bundling: xrayBundling,
  });
- grantBedrockInvoke(scope, diagnoseFn);
```

I deliberately left the CDK construct id as `"DiagnoseWithBedrockFunction"` and the entry
path/function name unchanged — renaming it is a bigger, purely-cosmetic diff (new Lambda
logical id → CloudFormation replaces the function, new ARN, `step-functions.ts` still
references it by the `diagnoseFn` variable so that part's fine either way). If you want the
name to stop saying "Bedrock", that's a separate, optional follow-up — not needed for this
migration to work.

**What this removes:** the `bedrock:InvokeModel` `PolicyStatement` that
`grantBedrockInvoke` was attaching to `diagnoseFn`'s execution role. Nothing else in that
role changes — it keeps its `incidents` table read/write grant.

`infra/lib/bedrockAccess.ts` is **not deleted** — it's simply no longer imported. Leaving it
in place costs nothing and makes rollback (§7) a one-file, one-line operation.

---

## 5. Set `GEMINI_API_KEY` before `cdk deploy`

CDK reads the key from `process.env` **at synth time**, on whatever machine runs
`cdk deploy` (your laptop or CI) — not inside AWS. Two ways to provide it:

**A. Export in your shell, then deploy (simplest, works everywhere):**

```bash
export GEMINI_API_KEY="AIza...your-key..."
cd infra
npx cdk deploy
```

**B. Inline for a single command (nothing left in shell history's env, but still visible in
process list briefly):**

```bash
cd infra
GEMINI_API_KEY="AIza...your-key..." npx cdk deploy
```

**Persisting it across terminal sessions** (optional — only if you'll be deploying repeatedly
from the same machine): add the `export` line to `~/.zshrc` / `~/.bashrc`, or create
`infra/.env.local` (already covered by the repo's `.gitignore` — confirmed: `.env` and
`.env.local` are both listed) and load it before deploying:

```bash
# infra/.env.local
GEMINI_API_KEY=AIza...your-key...
```

```bash
set -a; source infra/.env.local; set +a
npx cdk deploy
```

This avoids adding a `dotenv` dependency — `set -a`/`source` is a plain shell mechanism.

**Do not** put the key in `infra/cdk.json`'s `context` block — that file is committed to git.

**Get a Gemini API key:** Google AI Studio (`https://aistudio.google.com/apikey`) — I don't
have a verified, current step-by-step for that console since UI flows change; if the page
looks different from what you expect, that's likely just a UI update, not a wrong link.

---

## 6. For AI agents — apply commands

Run from the repo root (`self-healing-infra-main/`):

```bash
# 1. New Gemini client
mkdir -p server/src/shared/llm
cat > server/src/shared/llm/geminiClient.ts << 'EOF'
<paste the full contents of §1 here>
EOF

# 2. Swap the import in the diagnosis handler
sed -i 's#import { converseText } from "../../shared/aws/bedrockClient";#import { converseText } from "../../shared/llm/geminiClient";#' \
  server/src/features/diagnosis/handler.ts

# 3. New infra helper
cat > infra/lib/geminiAccess.ts << 'EOF'
<paste the full contents of §3 here>
EOF

# 4. Edit infra/lib/lambdas.ts — the import swap and env-var read are single-line sed-safe,
#    but the diagnoseFn block edit is safer done with a str_replace-style tool (exact
#    multi-line match) than sed. Apply the three diffs in §4 by hand or via an editor tool.

# 5. Build/typecheck before deploying
cd server && npx tsc --noEmit && cd ..
cd infra && npx tsc --noEmit && cd ..
```

Then set `GEMINI_API_KEY` per §5 and run `cdk deploy` from `infra/`.

---

## 7. For AI agents — revert / rollback commands

**If this is a git checkout** (fastest path — confirm with `git status` first that these are
the only changes before blanket-reverting):

```bash
git checkout -- server/src/features/diagnosis/handler.ts infra/lib/lambdas.ts
rm -f server/src/shared/llm/geminiClient.ts infra/lib/geminiAccess.ts
rmdir server/src/shared/llm 2>/dev/null  # only removes it if now empty
cd infra && npx cdk deploy   # redeploys with Bedrock wiring restored
```

**If not using git / need a manual revert** — reverse each diff from §2 and §4:

```bash
# handler.ts import back to Bedrock
sed -i 's#import { converseText } from "../../shared/llm/geminiClient";#import { converseText } from "../../shared/aws/bedrockClient";#' \
  server/src/features/diagnosis/handler.ts

# delete the two new files
rm -f server/src/shared/llm/geminiClient.ts infra/lib/geminiAccess.ts
rmdir server/src/shared/llm 2>/dev/null
```

Then manually restore in `infra/lib/lambdas.ts`:
- the import: `import { grantBedrockInvoke, DEFAULT_BEDROCK_MODEL_ID } from "./bedrockAccess";`
- remove the `geminiApiKey` / `geminiModelId` module-scope lines
- `diagnoseFn`'s `environment` back to `{ ...commonEnv, BEDROCK_MODEL_ID: DEFAULT_BEDROCK_MODEL_ID }`
- re-add `grantBedrockInvoke(scope, diagnoseFn);` right after the `diagnoseFn` declaration

Then `cd infra && npx cdk deploy`. This restores the exact Day 3 IAM policy and env var —
nothing about Day 1/Day 2 infra ever moved, so there's no cascading cleanup needed either
direction.

**To fully delete the Bedrock path later** (only once Gemini is confirmed stable and you
don't want the rollback option anymore — not part of this migration, listed for completeness):

```bash
rm server/src/shared/aws/bedrockClient.ts infra/lib/bedrockAccess.ts
```

---

## 8. Verify after deploying

1. `cd infra && npx cdk diff` before deploying — confirm the diff shows **only**:
   `DiagnoseWithBedrockFunction`'s environment variables changed, and its IAM role's inline
   policy losing the `bedrock:InvokeModel` statement. Nothing else (tables, alarms, other
   Lambdas, Step Functions definition) should appear in the diff.
2. Trigger the existing Day 2/3 fault-injection flow the same way you did for Day 3 testing
   (see `docs/TEST_DAY3.md`) and tail `DiagnoseWithBedrockFunction`'s CloudWatch log group —
   confirm it logs a successful Gemini call rather than a Bedrock `AccessDeniedException`.
3. Confirm the resulting `DiagnosisResult` item in the incidents table still has a non-empty
   `citedEvidenceIds` that passes the grounding check — i.e., the `DIAGNOSIS_NOT_GROUNDED`
   error path isn't firing on real evidence (it firing on genuinely-bad evidence is fine and
   expected — that's the safeguard working).
4. Spot-check the X-Ray trace for one `DiagnoseWithBedrockFunction` invocation and confirm a
   `gemini.converseText` subsegment appears.
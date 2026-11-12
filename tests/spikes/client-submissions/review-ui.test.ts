import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the main review preserves preview-first correction submission", async () => {
  const source = await readFile("apps/web/app/review-request.tsx", "utf8");

  assert.match(source, /fetch\("\/api\/demo\/client-submission"/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /Preview what would be shared/);
  assert.match(source, /Submit correction and place review hold/);
  assert.match(source, /agreementChanged: false/);
  assert.match(source, /paymentChanged: false/);
  assert.match(source, /QUESTION_SUBMISSION_UNSUPPORTED/);
  assert.match(source, /no durable question contract/);
});

test("the protected route owns the exact review basis and durable concern", async () => {
  const route = await readFile(
    "apps/web/app/api/demo/client-submission/route.ts",
    "utf8",
  );

  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(route, /u\.current_version as version/);
  assert.match(route, /v\.digest/);
  assert.match(route, /createConcernId: \(\) => `client-\$\{randomUUID\(\)\}`/);
  assert.match(route, /store\.admitCorrection\(actor, command\)/);
});

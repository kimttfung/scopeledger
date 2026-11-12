import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the main review keeps question and correction submissions distinct and preview-first", async () => {
  const source = await readFile("apps/web/app/review-request.tsx", "utf8");

  assert.match(source, /fetch\("\/api\/demo\/client-submission"/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /Preview what would be shared/);
  assert.match(source, /Submit question as communication only/);
  assert.match(source, /Submit correction and place review hold/);
  assert.match(source, /communicationEffect: "communication-only"/);
  assert.match(source, /reviewHoldCreated: false/);
  assert.match(source, /agreementChanged: false/);
  assert.match(source, /paymentChanged: false/);
  assert.match(source, /readinessChanged: false/);
  assert.match(source, /workStartChanged: false/);
  assert.match(source, /No notification delivery is claimed/);
  assert.match(source, /This preview creates no record or hold/);
  assert.doesNotMatch(source, /no durable question contract/);
});

test("the protected route owns the exact review basis, actor, and replay identity", async () => {
  const route = await readFile(
    "apps/web/app/api/demo/client-submission/route.ts",
    "utf8",
  );

  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(route, /u\.current_version as version/);
  assert.match(route, /v\.digest/);
  assert.match(route, /new PostgresAuthoringStore\(database\)/);
  assert.match(route, /authoringStore\.askQuestion/);
  assert.match(route, /askedBy: actor\.actorId/);
  assert.match(route, /questionIdFor\(session\.challengeId\)/);
  assert.match(route, /requestId: command\.packetId/);
  assert.match(route, /unitId: command\.unitId/);
  assert.match(route, /unitVersion: command\.unitVersion/);
  assert.match(route, /createConcernId: \(\) => `client-\$\{randomUUID\(\)\}`/);
  assert.match(route, /store\.admitCorrection\(actor, command\)/);
});

test("question requests contain only text, operation kind, and model permission", async () => {
  const source = await readFile("apps/web/app/review-request.tsx", "utf8");

  assert.match(
    source,
    /\{ kind, message, allowModel \}/,
  );
  assert.match(
    source,
    /\{ kind, message, source, allowModel \}/,
  );
  assert.doesNotMatch(source, /\{ kind, message, unitId/);
  assert.doesNotMatch(source, /\{ kind, message, version/);
  assert.doesNotMatch(source, /\{ kind, message, actor/);
});

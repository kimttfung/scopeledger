import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser surface previews every mutation and submits only allowed fields", async () => {
  const source = await readFile(
    "apps/web/app/review/[projectLocator]/[requestLocator]/[unitLocator]/review-actions.tsx",
    "utf8",
  );
  assert.match(source, /^"use client"/);
  assert.match(source, /showModal\(\)/);
  assert.match(source, /Nothing has been recorded yet/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /kind: "decision"/);
  assert.match(source, /reviewedExactVersion/);
  assert.match(source, /acknowledgedResponses/);
  assert.match(source, /kind: preview\.messageKind/);
  assert.match(source, /text,\s+allowModel/);
  assert.doesNotMatch(source, /fetch\([^)]*(payment|checkout|capture)/i);
  assert.doesNotMatch(source, /JSON\.stringify\([^)]*(workspaceId|projectId|unitId|version|digest|actorId|concernId|amount|readiness)/s);
});

test("honest success and error states keep payment unavailable", async () => {
  const source = await readFile(
    "apps/web/app/review/[projectLocator]/[requestLocator]/[unitLocator]/review-actions.tsx",
    "utf8",
  );
  for (const expected of [
    "Nothing was recorded against the stale page",
    "No review hold, agreement, payment, readiness, or work-start fact changed",
    "Correction recorded and the current unit was placed on review hold",
    "payment was not initiated or changed",
    "Payment remains separate",
    "Checkout, capture, reconciliation, and payment status changes are not",
    "Reload the current record",
  ]) {
    assert.match(source, new RegExp(expected));
  }
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /disabled=\{submitting\}/);
});

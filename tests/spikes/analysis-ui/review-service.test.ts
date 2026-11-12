import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisPersistenceError } from "@scopeledger/db";
import {
  reviewPersistenceFailure,
  validateReviewRequest,
} from "../../../apps/web/app/api/analysis/review-service.js";

const request = {
  reviewId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  disposition: "edit",
  note: "Edit the interpretation before any downstream preparation.",
} as const;

test("review request accepts only bounded explicit human disposition fields", () => {
  assert.deepEqual(validateReviewRequest(request), {
    ok: true,
    value: request,
  });

  const browserMetadata = validateReviewRequest({
    ...request,
    userAgent: "must-not-be-stored",
  });
  assert.equal(browserMetadata.ok, false);
  if (!browserMetadata.ok) assert.equal(browserMetadata.status, 400);

  const blank = validateReviewRequest({ ...request, note: " " });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.status, 422);

  const unsupported = validateReviewRequest({
    ...request,
    disposition: "publish",
  });
  assert.equal(unsupported.ok, false);
});

test("review persistence errors map to safe stable API failures", () => {
  assert.deepEqual(
    reviewPersistenceFailure(new AnalysisPersistenceError(
      "REVIEW_CONFLICT",
      "database detail must not escape",
    )),
    {
      status: 409,
      code: "ANALYSIS_REVIEW_CONFLICT",
      message: "That review identity is already bound to different content.",
    },
  );
  const unknown = reviewPersistenceFailure(new Error("secret connection detail"));
  assert.deepEqual(unknown, {
    status: 503,
    code: "ANALYSIS_REVIEW_STORAGE_FAILED",
    message: "The human review could not be saved.",
  });
});

import {
  AnalysisPersistenceError,
} from "@scopeledger/db";
import type {
  AnalysisReviewDisposition,
} from "../../provider/analysis/types.js";

type ReviewRequest = Readonly<{
  reviewId: string;
  runId: string;
  disposition: AnalysisReviewDisposition;
  note: string;
}>;

export type ReviewRequestValidation =
  | Readonly<{ ok: true; value: ReviewRequest }>
  | Readonly<{
    ok: false;
    status: 400 | 422;
    code: "INVALID_REVIEW_REQUEST";
    message: string;
  }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dispositions = new Set<AnalysisReviewDisposition>([
  "accept",
  "edit",
  "reject",
  "manual",
]);

export function validateReviewRequest(input: unknown): ReviewRequestValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REVIEW_REQUEST",
      message: "The review request must be a JSON object.",
    };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 4
    || keys.join(",") !== "disposition,note,reviewId,runId"
  ) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REVIEW_REQUEST",
      message: "The review request contains unsupported or missing fields.",
    };
  }
  if (
    typeof record.reviewId !== "string"
    || !uuidPattern.test(record.reviewId)
    || typeof record.runId !== "string"
    || !uuidPattern.test(record.runId)
    || typeof record.disposition !== "string"
    || !dispositions.has(record.disposition as AnalysisReviewDisposition)
    || typeof record.note !== "string"
  ) {
    return {
      ok: false,
      status: 422,
      code: "INVALID_REVIEW_REQUEST",
      message: "The run, review identity, disposition, or note is invalid.",
    };
  }
  const noteLength = Array.from(record.note).length;
  if (
    noteLength < 1
    || noteLength > 2_000
    || record.note !== record.note.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(record.note)
  ) {
    return {
      ok: false,
      status: 422,
      code: "INVALID_REVIEW_REQUEST",
      message: "The review note must contain 1 to 2,000 characters.",
    };
  }
  return {
    ok: true,
    value: {
      reviewId: record.reviewId.toLowerCase(),
      runId: record.runId.toLowerCase(),
      disposition: record.disposition as AnalysisReviewDisposition,
      note: record.note,
    },
  };
}

export function reviewPersistenceFailure(error: unknown): Readonly<{
  status: 400 | 403 | 404 | 409 | 503;
  code: string;
  message: string;
}> {
  if (error instanceof AnalysisPersistenceError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return {
          status: 400,
          code: "INVALID_REVIEW_REQUEST",
          message: "The review request was invalid.",
        };
      case "NOT_FOUND":
        return {
          status: 404,
          code: "ANALYSIS_RUN_NOT_FOUND",
          message: "The analysis run was not found.",
        };
      case "REVIEW_FORBIDDEN":
        return {
          status: 403,
          code: "ANALYSIS_REVIEW_FORBIDDEN",
          message: "This provider cannot review that analysis run.",
        };
      case "REVIEW_CONFLICT":
        return {
          status: 409,
          code: "ANALYSIS_REVIEW_CONFLICT",
          message: "That review identity is already bound to different content.",
        };
      default:
        break;
    }
  }
  return {
    status: 503,
    code: "ANALYSIS_REVIEW_STORAGE_FAILED",
    message: "The human review could not be saved.",
  };
}

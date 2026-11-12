import { z } from "zod";
import {
  isReviewPrefetch,
  privateReviewHeaders,
} from "./service";
import type {
  ReviewMutationBasis,
  ReviewMutationLocators,
  ReviewMutationSession,
} from "./mutation-service";

export type ReviewDraftKind = "question" | "correction";
export type ReviewDraftProjection = Readonly<{
  kind: ReviewDraftKind;
  revision: number;
  text: string;
  sourceText: string | null;
  allowModel: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}>;

export type ReviewDraftDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<ReviewMutationSession | null>;
  loadMutationBasis: (
    locators: ReviewMutationLocators,
    session: ReviewMutationSession,
  ) => Promise<ReviewMutationBasis>;
  readDraft: (
    basis: ReviewMutationBasis,
    session: ReviewMutationSession,
    kind: ReviewDraftKind,
  ) => Promise<ReviewDraftProjection | null>;
  saveDraft: (
    basis: ReviewMutationBasis,
    session: ReviewMutationSession,
    kind: ReviewDraftKind,
    input: Readonly<{
      expectedRevision: number | null;
      text: string;
      sourceText: string | null;
      allowModel: boolean;
    }>,
  ) => Promise<Readonly<{
    created: boolean;
    duplicate: boolean;
    draft: ReviewDraftProjection;
  }>>;
  deleteDraft: (
    basis: ReviewMutationBasis,
    session: ReviewMutationSession,
    kind: ReviewDraftKind,
    expectedRevision: number,
  ) => Promise<Readonly<{ deleted: boolean }>>;
}>;

const draftWriteSchema = z.strictObject({
  expectedRevision: z.number().int().positive().nullable(),
  text: z.string(),
  sourceText: z.string().nullable(),
  allowModel: z.boolean(),
});
const draftDeleteSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const invalidControl = /(?![\t\n])\p{Cc}/u;
const TEXT_LIMIT = 10_000;

const draftEffects = Object.freeze({
  submissionCreated: false,
  reviewHoldCreated: false,
  notificationCreated: false,
  modelCalled: false,
  publicationChanged: false,
  agreementChanged: false,
  paymentChanged: false,
  readinessChanged: false,
});

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: privateReviewHeaders,
  });
}

function validKind(value: string): value is ReviewDraftKind {
  return value === "question" || value === "correction";
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validText(value: string, required: boolean): boolean {
  return codePointLength(value) <= TEXT_LIMIT
    && !invalidUnicode.test(value)
    && !invalidControl.test(value)
    && (!required || value.trim().length > 0);
}

function loadFailure(error: unknown): Response | null {
  if (
    typeof error !== "object"
    || error === null
    || !("name" in error)
    || error.name !== "ReviewLoadError"
    || !("code" in error)
    || typeof error.code !== "string"
  ) {
    return null;
  }
  switch (error.code) {
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "REVIEW_DRAFT_NOT_AUTHORIZED",
      }, 403);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "REVIEW_DRAFT_NOT_AVAILABLE",
      }, 404);
    case "STALE_RECORD":
    case "MALFORMED_RECORD":
      return json({
        ok: false,
        code: "REVIEW_STATE_CHANGED",
      }, 409);
  }
  return null;
}

function storeFailure(error: unknown): Response {
  const code = typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
    ? error.code
    : null;
  if (code === "ACCESS_DENIED") {
    return json({
      ok: false,
      code: "REVIEW_DRAFT_NOT_AUTHORIZED",
    }, 403);
  }
  if (code === "DRAFT_CONFLICT") {
    return json({
      ok: false,
      code: "REVIEW_DRAFT_CONFLICT",
    }, 409);
  }
  if (code === "INVALID_INPUT") {
    return json({
      ok: false,
      code: "INVALID_REVIEW_DRAFT",
    }, 422);
  }
  return json({
    ok: false,
    code: "REVIEW_DRAFT_UNAVAILABLE",
  }, 503);
}

async function authorize(
  locators: ReviewMutationLocators,
  kindValue: string,
  dependencies: ReviewDraftDependencies,
): Promise<
  | Readonly<{
    ok: true;
    kind: ReviewDraftKind;
    session: ReviewMutationSession;
    basis: ReviewMutationBasis;
  }>
  | Readonly<{ ok: false; response: Response }>
> {
  if (!validKind(kindValue)) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "REVIEW_DRAFT_NOT_AVAILABLE",
      }, 404),
    };
  }
  let session: ReviewMutationSession | null;
  try {
    session = await dependencies.readSession();
  } catch {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "REVIEW_ACCESS_UNAVAILABLE",
      }, 503),
    };
  }
  if (!session) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "CLIENT_ACCESS_REQUIRED",
      }, 401),
    };
  }
  if (session.role !== "client-approver") {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "CLIENT_APPROVER_REQUIRED",
      }, 403),
    };
  }
  let basis: ReviewMutationBasis;
  try {
    basis = await dependencies.loadMutationBasis(locators, session);
  } catch (error) {
    return {
      ok: false,
      response: loadFailure(error) ?? json({
        ok: false,
        code: "REVIEW_ACCESS_UNAVAILABLE",
      }, 503),
    };
  }
  if (kindValue === "correction" && basis.correctGrantEpoch === null) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "REVIEW_DRAFT_NOT_AUTHORIZED",
      }, 403),
    };
  }
  return {
    ok: true,
    kind: kindValue,
    session,
    basis,
  };
}

export async function handleReviewDraftGet(
  request: Request,
  locators: ReviewMutationLocators,
  kindValue: string,
  dependencies: ReviewDraftDependencies,
): Promise<Response> {
  if (isReviewPrefetch(request.headers)) {
    return json({
      ok: false,
      code: "REVIEW_PREFETCH_REJECTED",
    }, 403);
  }
  const access = await authorize(locators, kindValue, dependencies);
  if (!access.ok) return access.response;
  try {
    return json({
      ok: true,
      draft: await dependencies.readDraft(
        access.basis,
        access.session,
        access.kind,
      ),
      effect: "private-draft-only",
      ...draftEffects,
    }, 200);
  } catch (error) {
    return storeFailure(error);
  }
}

export async function handleReviewDraftPut(
  request: Request,
  locators: ReviewMutationLocators,
  kindValue: string,
  dependencies: ReviewDraftDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "REVIEW_DRAFT_ORIGIN_REQUIRED",
    }, 403);
  }
  const access = await authorize(locators, kindValue, dependencies);
  if (!access.ok) return access.response;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_REVIEW_DRAFT" }, 422);
  }
  const parsed = draftWriteSchema.safeParse(input);
  if (!parsed.success) {
    return json({ ok: false, code: "INVALID_REVIEW_DRAFT" }, 422);
  }
  if (
    !validText(parsed.data.text, true)
    || (
      parsed.data.sourceText !== null
      && !validText(parsed.data.sourceText, true)
    )
  ) {
    return json({
      ok: false,
      code: codePointLength(parsed.data.text) > TEXT_LIMIT
          || (
            parsed.data.sourceText !== null
            && codePointLength(parsed.data.sourceText) > TEXT_LIMIT
          )
        ? "REVIEW_DRAFT_TEXT_LIMIT"
        : "INVALID_REVIEW_DRAFT",
    }, 422);
  }
  if (access.kind === "question" && parsed.data.sourceText !== null) {
    return json({ ok: false, code: "INVALID_REVIEW_DRAFT" }, 422);
  }
  try {
    const saved = await dependencies.saveDraft(
      access.basis,
      access.session,
      access.kind,
      parsed.data,
    );
    return json({
      ok: true,
      draft: saved.draft,
      duplicate: saved.duplicate,
      effect: "private-draft-only",
      ...draftEffects,
    }, saved.created ? 201 : 200);
  } catch (error) {
    return storeFailure(error);
  }
}

export async function handleReviewDraftDelete(
  request: Request,
  locators: ReviewMutationLocators,
  kindValue: string,
  dependencies: ReviewDraftDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "REVIEW_DRAFT_ORIGIN_REQUIRED",
    }, 403);
  }
  const access = await authorize(locators, kindValue, dependencies);
  if (!access.ok) return access.response;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_REVIEW_DRAFT" }, 422);
  }
  const parsed = draftDeleteSchema.safeParse(input);
  if (!parsed.success) {
    return json({ ok: false, code: "INVALID_REVIEW_DRAFT" }, 422);
  }
  try {
    const deleted = await dependencies.deleteDraft(
      access.basis,
      access.session,
      access.kind,
      parsed.data.expectedRevision,
    );
    return json({
      ok: true,
      deleted: deleted.deleted,
      effect: "private-draft-only",
      ...draftEffects,
    }, 200);
  } catch (error) {
    return storeFailure(error);
  }
}

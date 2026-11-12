import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  handleReviewMutationPost,
  type ReviewMutationBasis,
  type ReviewMutationDependencies,
} from "../../../apps/web/app/api/review/mutation-service.js";
import {
  ReviewLocatorCodec,
} from "../../../apps/web/app/api/review/service.js";

type ReviewDraftProjection = Readonly<{
  kind: "question" | "correction";
  revision: number;
  text: string;
  sourceText: string | null;
  allowModel: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}>;
type DraftSession = Readonly<{
  subject: string;
  role: "client-approver" | "payer";
  challengeId: string;
}>;
type DraftLocators = Readonly<{
  projectLocator: string;
  requestLocator: string;
  unitLocator: string;
}>;
type ReviewDraftDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<DraftSession | null>;
  loadMutationBasis: () => Promise<ReviewMutationBasis>;
  readDraft: () => Promise<ReviewDraftProjection | null>;
  saveDraft: (
    basis: ReviewMutationBasis,
    sessionValue: DraftSession,
    kind: "question" | "correction",
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
    sessionValue: DraftSession,
    kind: "question" | "correction",
    expectedRevision: number,
  ) => Promise<Readonly<{ deleted: boolean }>>;
}>;

const draftService = await import(pathToFileURL(resolve(
  "apps/web/app/api/review/draft-service.ts",
)).href) as Readonly<{
  handleReviewDraftDelete: (
    request: Request,
    locators: DraftLocators,
    kind: string,
    dependencies: ReviewDraftDependencies,
  ) => Promise<Response>;
  handleReviewDraftGet: (
    request: Request,
    locators: DraftLocators,
    kind: string,
    dependencies: ReviewDraftDependencies,
  ) => Promise<Response>;
  handleReviewDraftPut: (
    request: Request,
    locators: DraftLocators,
    kind: string,
    dependencies: ReviewDraftDependencies,
  ) => Promise<Response>;
}>;
const {
  handleReviewDraftDelete,
  handleReviewDraftGet,
  handleReviewDraftPut,
} = draftService;

const codec = new ReviewLocatorCodec("11".repeat(32));
const projectLocator = codec.project("workspace-one", "project-one");
const requestLocator = codec.request(
  "workspace-one",
  "project-one",
  "request-one",
);
const unitLocator = codec.mutationUnit(
  "workspace-one",
  "project-one",
  "request-one",
  "unit-one",
  2,
  "a".repeat(64),
);
const locators = { projectLocator, requestLocator, unitLocator };
const session = {
  subject: "b".repeat(64),
  role: "client-approver" as const,
  challengeId: "11111111-1111-4111-8111-111111111111",
};
const basis: ReviewMutationBasis = {
  workspaceId: "workspace-one",
  projectId: "project-one",
  requestId: "request-one",
  unitId: "unit-one",
  version: 2,
  digest: "a".repeat(64),
  actorId: "approver-one",
  nominationEpoch: 1,
  decideGrantEpoch: 1,
  correctGrantEpoch: 1,
  terminalDecision: null,
  resolutionConcerns: [],
};
const projection: ReviewDraftProjection = {
  kind: "correction",
  revision: 3,
  text: "  Correction 😀\nexact  ",
  sourceText: "  Signed scope §4  ",
  allowModel: true,
  createdAt: "2026-11-12T12:00:00.000Z",
  updatedAt: "2026-11-13T12:00:00.000Z",
  expiresAt: "2026-11-20T12:00:00.000Z",
};

function draftDependencies(
  overrides: Partial<ReviewDraftDependencies> = {},
): ReviewDraftDependencies {
  return {
    requireSameOrigin: () => undefined,
    readSession: async () => session,
    loadMutationBasis: async () => basis,
    readDraft: async () => projection,
    saveDraft: async () => ({
      created: false,
      duplicate: false,
      draft: projection,
    }),
    deleteDraft: async () => ({ deleted: true }),
    ...overrides,
  };
}

function draftRequest(
  method: "GET" | "PUT" | "DELETE",
  body?: object,
): Request {
  return new Request(
    `http://127.0.0.1:3000/api/review/${projectLocator}/${requestLocator}/${unitLocator}/drafts/correction`,
    {
      method,
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

test("draft owner projection returns only private content and safe metadata", async () => {
  const response = await handleReviewDraftGet(
    draftRequest("GET"),
    locators,
    "correction",
    draftDependencies(),
  );
  assert.equal(response.status, 200);
  const result = await response.json() as Record<string, unknown>;
  assert.deepEqual(result.draft, projection);
  assert.equal(result.effect, "private-draft-only");
  for (const effect of [
    "submissionCreated",
    "reviewHoldCreated",
    "notificationCreated",
    "modelCalled",
    "publicationChanged",
    "agreementChanged",
    "paymentChanged",
    "readinessChanged",
  ]) {
    assert.equal(result[effect], false);
  }
  const serialized = JSON.stringify(result);
  for (const privateIdentity of [
    "participantSubjectDigest",
    "actorId",
    "draftDigest",
    "@scopeledger.test",
  ]) {
    assert.equal(serialized.includes(privateIdentity), false);
  }
});

test("payer, revoked correction, and cross-origin access fail before draft storage", async () => {
  for (const [dependencies, expected] of [
    [draftDependencies({
      readSession: async () => ({
        ...session,
        role: "payer",
      }),
    }), 403],
    [draftDependencies({
      loadMutationBasis: async () => ({
        ...basis,
        correctGrantEpoch: null,
      }),
    }), 403],
  ] as const) {
    let read = false;
    const response = await handleReviewDraftGet(
      draftRequest("GET"),
      locators,
      "correction",
      {
        ...dependencies,
        readDraft: async () => {
          read = true;
          return projection;
        },
      },
    );
    assert.equal(response.status, expected);
    assert.equal(read, false);
  }

  let sessionRead = false;
  const crossOrigin = await handleReviewDraftPut(
    draftRequest("PUT", {
      expectedRevision: null,
      text: "Exact draft",
      sourceText: null,
      allowModel: false,
    }),
    locators,
    "correction",
    draftDependencies({
      requireSameOrigin: () => {
        throw new Error("SAME_ORIGIN_REQUIRED");
      },
      readSession: async () => {
        sessionRead = true;
        return session;
      },
    }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(sessionRead, false);
});

test("save and delete preserve exact Unicode, revision, and private-only effects", async () => {
  const savedInput: unknown[] = [];
  const saved = await handleReviewDraftPut(
    draftRequest("PUT", {
      expectedRevision: 2,
      text: projection.text,
      sourceText: projection.sourceText,
      allowModel: true,
    }),
    locators,
    "correction",
    draftDependencies({
      saveDraft: async (_basis, _session, _kind, input) => {
        savedInput.push(input);
        return {
          created: false,
          duplicate: false,
          draft: projection,
        };
      },
    }),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(savedInput, [{
    expectedRevision: 2,
    text: projection.text,
    sourceText: projection.sourceText,
    allowModel: true,
  }]);

  const deletedRevisions: number[] = [];
  const deleted = await handleReviewDraftDelete(
    draftRequest("DELETE", { expectedRevision: 3 }),
    locators,
    "correction",
    draftDependencies({
      deleteDraft: async (_basis, _session, _kind, revision) => {
        deletedRevisions.push(revision);
        return { deleted: true };
      },
    }),
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(deletedRevisions, [3]);
});

test("stale draft conflicts and oversized Unicode fail without truncation", async () => {
  const conflict = await handleReviewDraftPut(
    draftRequest("PUT", {
      expectedRevision: 1,
      text: "Changed content",
      sourceText: null,
      allowModel: false,
    }),
    locators,
    "correction",
    draftDependencies({
      saveDraft: async () => {
        throw Object.assign(new Error("internal"), {
          code: "DRAFT_CONFLICT",
        });
      },
    }),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    ok: false,
    code: "REVIEW_DRAFT_CONFLICT",
  });

  let saved = false;
  const exactLimit = "😀".repeat(10_000);
  const accepted = await handleReviewDraftPut(
    draftRequest("PUT", {
      expectedRevision: null,
      text: exactLimit,
      sourceText: null,
      allowModel: false,
    }),
    locators,
    "correction",
    draftDependencies({
      saveDraft: async () => {
        saved = true;
        return {
          created: true,
          duplicate: false,
          draft: { ...projection, text: exactLimit },
        };
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.equal(saved, true);

  const rejected = await handleReviewDraftPut(
    draftRequest("PUT", {
      expectedRevision: null,
      text: `${exactLimit}😀`,
      sourceText: null,
      allowModel: false,
    }),
    locators,
    "correction",
    draftDependencies(),
  );
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), {
    ok: false,
    code: "REVIEW_DRAFT_TEXT_LIMIT",
  });
});

function mutationRequest(body: object): Request {
  return new Request(
    `http://127.0.0.1:3000/api/review/${projectLocator}/${requestLocator}/${unitLocator}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
      },
      body: JSON.stringify(body),
    },
  );
}

function mutationDependencies(
  events: string[],
  overrides: Partial<ReviewMutationDependencies> = {},
): ReviewMutationDependencies {
  return {
    requireSameOrigin: () => undefined,
    readSession: async () => session,
    loadMutationBasis: async () => basis,
    decide: async () => ({ decision: "approve", obligationId: null }),
    askQuestion: async () => {
      events.push("persist-question");
      return { duplicate: false };
    },
    admitCorrection: async (_basis, command) => {
      events.push(`persist-correction:${command.claim.source.availability}`);
      return {
        concernId: command.concernId,
        affectedUnitIds: [basis.unitId],
      };
    },
    createId: () => "22222222-2222-4222-8222-222222222222",
    closeDraft: async (_basis, _session, kind, revision) => {
      events.push(`close-${kind}:${revision}`);
      return true;
    },
    ...overrides,
  };
}

test("submission persists first and closes only the submitted exact draft revision", async () => {
  const failedEvents: string[] = [];
  const failed = await handleReviewMutationPost(
    mutationRequest({
      kind: "question",
      text: "Question from draft.",
      allowModel: false,
      draftRevision: 4,
    }),
    locators,
    mutationDependencies(failedEvents, {
      askQuestion: async () => {
        failedEvents.push("persist-question");
        throw new Error("database unavailable");
      },
    }),
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(failedEvents, ["persist-question"]);

  const questionEvents: string[] = [];
  const question = await handleReviewMutationPost(
    mutationRequest({
      kind: "question",
      text: "Question from draft.",
      allowModel: false,
      draftRevision: 4,
    }),
    locators,
    mutationDependencies(questionEvents),
  );
  assert.equal(question.status, 201);
  assert.deepEqual(questionEvents, [
    "persist-question",
    "close-question:4",
  ]);
  assert.equal(
    (await question.json() as { draftClosed: boolean }).draftClosed,
    true,
  );

  const correctionEvents: string[] = [];
  const correction = await handleReviewMutationPost(
    mutationRequest({
      kind: "correction",
      text: "Correction from draft.",
      sourceText: "  Signed scope §4  ",
      allowModel: true,
      draftRevision: 7,
    }),
    locators,
    mutationDependencies(correctionEvents, {
      closeDraft: async (_basis, _session, kind, revision) => {
        correctionEvents.push(`close-${kind}:${revision}`);
        return false;
      },
    }),
  );
  assert.equal(correction.status, 201);
  assert.deepEqual(correctionEvents, [
    "persist-correction:available",
    "close-correction:7",
  ]);
  assert.equal(
    (await correction.json() as { draftClosed: boolean }).draftClosed,
    false,
  );
});

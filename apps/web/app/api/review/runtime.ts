import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { AccessSessionCodec } from "@scopeledger/access";
import {
  ClientReviewDraftError,
  PostgresAuthoringStore,
  PostgresClientReviewDraftStore,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  localAccessRuntime,
  requireSameOrigin,
} from "../../../lib/local-access";
import { protocolDatabase } from "../../../lib/protocol-database";
import {
  loadDatabaseReview,
  loadDatabaseReviewMutationBasis,
} from "./database";
import {
  ReviewLocatorCodec,
  type ReviewDependencies,
} from "./service";
import type {
  ReviewMutationDependencies,
  ReviewMutationBasis,
  ReviewMutationSession,
} from "./mutation-service";
import type {
  ReviewDraftDependencies,
  ReviewDraftKind,
  ReviewDraftProjection,
} from "./draft-service";

export type ReviewRuntimeDependencies =
  & ReviewDependencies
  & ReviewMutationDependencies
  & ReviewDraftDependencies;

function deterministicUuid(parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
  const variant = (
    (Number.parseInt(hex[16]!, 16) & 0x3) | 0x8
  ).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function reviewDependencies(): ReviewRuntimeDependencies | null {
  const access = localAccessRuntime();
  const database = protocolDatabase();
  const secret = process.env.ACCESS_SESSION_SECRET;
  if (!access || !database || !secret) return null;
  const codec = new ReviewLocatorCodec(secret);
  const expectedSubject = new AccessSessionCodec(secret).subject(
    access.clientRecipient,
    "client-approver",
  );
  const consentStore = new OrderedConsentStore(database);
  const authoringStore = new PostgresAuthoringStore(database);
  const draftStore = new PostgresClientReviewDraftStore(database);
  const draftAuthority = (
    basis: ReviewMutationBasis,
    session: ReviewMutationSession,
    kind: ReviewDraftKind,
  ) => ({
    workspaceId: basis.workspaceId,
    projectId: basis.projectId,
    requestId: basis.requestId,
    unitId: basis.unitId,
    participantSubjectDigest: session.subject,
    actorId: basis.actorId,
    nominationEpoch: basis.nominationEpoch,
    kind,
  });
  const draftProjection = (
    draft: Awaited<ReturnType<typeof draftStore.read>>,
  ): ReviewDraftProjection | null => draft
    ? Object.freeze({
      kind: draft.kind,
      revision: draft.revision,
      text: draft.exactText,
      sourceText: draft.correctionSourceText,
      allowModel: draft.modelProcessing === "permitted",
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
      expiresAt: draft.expiresAt.toISOString(),
    })
    : null;
  return Object.freeze({
    requireSameOrigin,
    readSession: async () => {
      const token = (await cookies()).get(access.cookieName)?.value;
      return access.store.readSession(token);
    },
    loadReview: (locators, session) => loadDatabaseReview({
      database,
      codec,
      expectedSubject,
      locators,
      session,
    }),
    loadMutationBasis: (locators, session) =>
      loadDatabaseReviewMutationBasis({
        database,
        codec,
        expectedSubject,
        locators,
        session,
      }),
    decide: async (basis, command) => consentStore.decide({
      workspaceId: basis.workspaceId,
      projectId: basis.projectId,
      actorId: basis.actorId,
      grantEpoch: basis.decideGrantEpoch,
    }, command),
    askQuestion: async (basis, command) => {
      const result = await authoringStore.askQuestion({
        workspaceId: basis.workspaceId,
        projectId: basis.projectId,
        questionId: command.questionId,
        requestId: command.requestId,
        unitId: command.unitId,
        unitVersion: command.unitVersion,
        askedBy: command.askedBy,
        exactText: command.exactText,
        modelProcessing: command.modelProcessing,
      });
      return { duplicate: result.duplicate };
    },
    admitCorrection: async (basis, command) => {
      if (basis.correctGrantEpoch === null) {
        throw Object.assign(new Error("Correction grant unavailable"), {
          code: "ACCESS_DENIED",
        });
      }
      return consentStore.admitCorrection({
        workspaceId: basis.workspaceId,
        projectId: basis.projectId,
        actorId: basis.actorId,
        grantEpoch: basis.correctGrantEpoch,
      }, command);
    },
    createId: (kind, basis, session) => deterministicUuid([
      "scopeledger.dynamic-client-review.mutation.v1",
      kind,
      basis.workspaceId,
      basis.projectId,
      basis.requestId,
      basis.unitId,
      String(basis.version),
      basis.digest,
      basis.actorId,
      String(basis.nominationEpoch),
      session.challengeId,
    ]),
    readDraft: async (basis, session, kind) =>
      draftProjection(await draftStore.read(
        draftAuthority(basis, session, kind),
      )),
    saveDraft: async (basis, session, kind, input) => {
      const saved = await draftStore.save(
        draftAuthority(basis, session, kind),
        {
          expectedRevision: input.expectedRevision,
          exactText: input.text,
          correctionSourceText: input.sourceText,
          modelProcessing: input.allowModel ? "permitted" : "denied",
        },
      );
      return Object.freeze({
        created: saved.created,
        duplicate: saved.duplicate,
        draft: draftProjection(saved.draft)!,
      });
    },
    deleteDraft: (basis, session, kind, expectedRevision) =>
      draftStore.delete(
        draftAuthority(basis, session, kind),
        expectedRevision,
      ),
    closeDraft: async (basis, session, kind, revision) => {
      try {
        return (await draftStore.delete(
          draftAuthority(basis, session, kind),
          revision,
        )).deleted;
      } catch (error) {
        if (
          error instanceof ClientReviewDraftError
          && (
            error.code === "DRAFT_CONFLICT"
            || error.code === "ACCESS_DENIED"
          )
        ) {
          return false;
        }
        throw error;
      }
    },
  });
}

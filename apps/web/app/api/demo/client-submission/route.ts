import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import {
  PostgresAuthoringStore,
  sql,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  localAccessRuntime,
  requireSameOrigin,
} from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { handleClientSubmissionPost } from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actor = {
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  actorId: "cedar-approver",
  grantEpoch: 1,
};
const reviewedUnitId = "unit-u1";

function questionIdFor(challengeId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([
    "scopeledger-client-question-v1",
    actor.workspaceId,
    actor.projectId,
    actor.actorId,
    challengeId,
  ])).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export async function POST(request: Request): Promise<Response> {
  const access = localAccessRuntime();
  if (!access) {
    return Response.json(
      { ok: false, code: "SUBMISSION_ACCESS_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const database = protocolDatabase();
  if (!database) {
    return Response.json(
      { ok: false, code: "SUBMISSION_SERVICE_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const store = new OrderedConsentStore(database);
  const authoringStore = new PostgresAuthoringStore(database);
  return handleClientSubmissionPost(request, {
    requireSameOrigin,
    readSession: async () => {
      const token = (await cookies()).get(access.cookieName)?.value;
      return access.store.readSession(token);
    },
    loadCurrentBasis: async () => database.transaction(async (transaction) => {
      const row = (await sql<{
        unit_id: string;
        packet_id: string;
        version: number;
        digest: string;
      }>`
        select
          u.id as unit_id,
          u.packet_id,
          u.current_version as version,
          v.digest
        from units u
        join unit_versions v
          on v.workspace_id = u.workspace_id
          and v.project_id = u.project_id
          and v.unit_id = u.id
          and v.version = u.current_version
        where u.workspace_id = ${actor.workspaceId}
          and u.project_id = ${actor.projectId}
          and u.id = ${reviewedUnitId}
      `.execute(transaction)).rows[0];
      return row
        ? {
          unitId: row.unit_id,
          packetId: row.packet_id,
          version: row.version,
          digest: row.digest,
        }
        : null;
    }),
    askQuestion: async (command) => {
      const result = await authoringStore.askQuestion({
        workspaceId: actor.workspaceId,
        projectId: actor.projectId,
        questionId: command.questionId,
        requestId: command.packetId,
        unitId: command.unitId,
        unitVersion: command.unitVersion,
        askedBy: actor.actorId,
        exactText: command.exactText,
        modelProcessing: command.modelProcessing,
      });
      return {
        duplicate: result.duplicate,
        question: {
          questionId: result.question.questionId,
          packetId: result.question.requestId,
          unitId: result.question.unitId,
          unitVersion: result.question.unitVersion,
          communicationEffect: result.question.communicationEffect,
        },
      };
    },
    admitCorrection: async (command) => store.admitCorrection(actor, command),
    createQuestionId: (session) => questionIdFor(session.challengeId),
    createCommandId: randomUUID,
    createConcernId: () => `client-${randomUUID()}`,
  });
}

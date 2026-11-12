import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { sql } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  localAccessRuntime,
  requireSameOrigin,
} from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import {
  handleDecisionPost,
} from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actor = {
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  actorId: "cedar-approver",
  grantEpoch: 1,
};
const reviewedUnit = {
  unitId: "unit-u1",
  version: 2,
};

export async function POST(request: Request): Promise<Response> {
  const access = localAccessRuntime();
  if (!access) {
    return Response.json(
      { ok: false, code: "DECISION_ACCESS_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const database = protocolDatabase();
  if (!database) {
    return Response.json(
      { ok: false, code: "DECISION_SERVICE_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const store = new OrderedConsentStore(database);
  return handleDecisionPost(request, {
    requireSameOrigin,
    readSession: async () => {
      const token = (await cookies()).get(access.cookieName)?.value;
      return access.store.readSession(token);
    },
    loadCurrentUnit: async () => database.transaction(async (transaction) => {
      const row = (await sql<{
        unit_id: string;
        version: number;
        digest: string;
      }>`
        select u.id as unit_id, u.current_version as version, v.digest
        from units u
        join unit_versions v
          on v.workspace_id = u.workspace_id
          and v.project_id = u.project_id
          and v.unit_id = u.id
          and v.version = u.current_version
        where u.workspace_id = ${actor.workspaceId}
          and u.project_id = ${actor.projectId}
          and u.id = ${reviewedUnit.unitId}
          and u.current_version = ${reviewedUnit.version}
      `.execute(transaction)).rows[0];
      return row
        ? {
          unitId: row.unit_id,
          version: row.version,
          digest: row.digest,
        }
        : null;
    }),
    decide: async (command) => store.decide(actor, command),
    createCommandId: randomUUID,
  });
}

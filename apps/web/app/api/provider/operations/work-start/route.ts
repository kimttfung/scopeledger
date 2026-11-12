import { randomUUID } from "node:crypto";
import { sql } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { requireSameOrigin } from "../../../../../lib/local-access";
import { protocolDatabase } from "../../../../../lib/protocol-database";
import { verifiedProvider } from "../../../analysis/provider-api";
import {
  handleWorkStartGet,
  handleWorkStartPost,
  type WorkStartDependencies,
} from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unitId = "unit-u1";
const providerActor = Object.freeze({
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  actorId: "northstar-provider",
  grantEpoch: 1,
});

function dependencies(): WorkStartDependencies {
  return {
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    createCommandId: randomUUID,
    readSnapshot: async () => {
      const database = protocolDatabase();
      if (!database) throw new Error("WORK_START_DATABASE_UNAVAILABLE");
      const store = new OrderedConsentStore(database);
      const state = await store.inspectUnit(providerActor, unitId);
      const existing = (await sql<{
        version: number;
        recorded_at: Date;
      }>`
        select (detail->>'version')::integer as version, recorded_at
        from protocol_history
        where workspace_id = ${providerActor.workspaceId}
          and project_id = ${providerActor.projectId}
          and event = 'work-started'
          and resource_id = ${unitId}
        order by sequence
        limit 1
      `.execute(database.kysely)).rows[0];
      return {
        unitId: state.unitId,
        acceptedVersion: state.acceptedVersion,
        readiness: state.readiness,
        activeHoldCount: state.holds.length,
        workStart: existing
          ? {
            unitId,
            version: existing.version,
            startedAt: existing.recorded_at.toISOString(),
          }
          : null,
      };
    },
    recordWorkStart: ({ commandId }) => {
      const database = protocolDatabase();
      if (!database) throw new Error("WORK_START_DATABASE_UNAVAILABLE");
      return new OrderedConsentStore(database).observeWorkStart(providerActor, {
        commandId,
        unitId,
      });
    },
  };
}

export async function GET(): Promise<Response> {
  return handleWorkStartGet(dependencies());
}

export async function POST(request: Request): Promise<Response> {
  return handleWorkStartPost(request, dependencies());
}

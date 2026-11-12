import {
  OrderedConsentStore,
} from "@scopeledger/domain";
import { protocolDatabase } from "../../../../lib/protocol-database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actor = {
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  actorId: "cedar-approver",
  grantEpoch: 1,
};

export async function GET(): Promise<Response> {
  const database = protocolDatabase();
  if (!database) {
    return Response.json(
      { connected: false, code: "DEMO_DATABASE_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  try {
    const state = await new OrderedConsentStore(database).inspectUnit(
      actor,
      "unit-u1",
    );
    return Response.json({
      connected: true,
      unitId: state.unitId,
      currentVersion: state.currentVersion,
      acceptedVersion: state.acceptedVersion,
      readiness: state.readiness,
      holds: state.holds.map((hold) => ({
        reason: hold.reason,
        concernId: hold.concern_id,
      })),
      workStartRecorded: false,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { connected: false, code: "DEMO_STATE_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

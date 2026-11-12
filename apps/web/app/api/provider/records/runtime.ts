import {
  ProtocolDatabaseRecordsReader,
  exportProjectRecords,
} from "@scopeledger/records-export";
import { sql } from "@scopeledger/db";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  ProviderRecordsLocatorCodec,
  type ProviderRecordTarget,
  type ProviderRecordsDependencies,
} from "./service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const authorityProjectId = "cedar-roastery";
const MAX_PROJECT_CANDIDATES = 256;

function currentDatabase() {
  const database = protocolDatabase();
  if (!database) throw new Error("PROVIDER_RECORDS_DATABASE_UNAVAILABLE");
  return database;
}

export function providerRecordsDependencies():
  ProviderRecordsDependencies | null {
  const secret = process.env.ACCESS_SESSION_SECRET;
  const database = protocolDatabase();
  if (!secret || !database) return null;
  const locatorCodec = new ProviderRecordsLocatorCodec(secret);

  return Object.freeze({
    verifyProvider: verifiedProvider,
    verifyProductGrant: async () => {
      const result = await sql`select 1 from grants
        where workspace_id = ${workspaceId}
          and project_id = ${authorityProjectId}
          and actor_id = ${providerActorId}
          and action = 'inspect'
          and active = true
        limit 1`.execute(currentDatabase().kysely);
      return result.rows.length === 1;
    },
    listAuthorizedProjects: async () => {
      const rows = (await sql<{
        project_id: string;
        display_name: string | null;
        grant_epoch: number;
      }>`select p.id as project_id,p.provider_display_name as display_name,
          g.epoch as grant_epoch
        from projects p
        join grants g
          on g.workspace_id = p.workspace_id
          and g.project_id = p.id
          and g.actor_id = ${providerActorId}
          and g.action = 'inspect'
          and g.active = true
        where p.workspace_id = ${workspaceId}
        order by p.provider_display_name collate "C" nulls last,
          p.id collate "C"
        limit ${MAX_PROJECT_CANDIDATES + 1}`
        .execute(currentDatabase().kysely)).rows;
      return Object.freeze(rows.map((row): ProviderRecordTarget =>
        Object.freeze({
          workspaceId,
          projectId: row.project_id,
          displayName: row.display_name,
          grantEpoch: row.grant_epoch,
        })));
    },
    isProjectGrantCurrent: async (target) => {
      const result = await sql`select 1 from grants
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and actor_id = ${providerActorId}
          and action = 'inspect'
          and epoch = ${target.grantEpoch}
          and active = true
        limit 1`.execute(currentDatabase().kysely);
      return result.rows.length === 1;
    },
    exportProject: (target) =>
      exportProjectRecords(
        new ProtocolDatabaseRecordsReader(currentDatabase()),
        {
          workspaceId: target.workspaceId,
          projectId: target.projectId,
        },
      ),
    locatorCodec,
  });
}

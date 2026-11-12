import {
  PostgresAuthoringStore,
  sql,
} from "@scopeledger/db";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import type {
  ProviderSourceDependencies,
  ProviderSourceTarget,
  TargetAuthorization,
} from "./service";
import { providerSourceScopePrefix } from "./service";
import { providerSourceStorage } from "./storage-runtime";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function resolveTarget(
  locator: string,
  grantAction: ProviderSourceTarget["grantAction"],
): ProviderSourceTarget | null {
  const parts = locator.split("/");
  const projectId = parts[0];
  const requestId = parts[1];
  if (
    parts.length !== 2
    || !projectId
    || !requestId
    || !identifierPattern.test(projectId)
    || !identifierPattern.test(requestId)
  ) {
    return null;
  }
  return Object.freeze({
    workspaceId: "demo-workspace",
    projectId,
    requestId,
    providerActorId: "northstar-provider",
    grantAction,
    grantEpoch: 1,
  });
}

export async function providerSourceDependencies(): Promise<
  ProviderSourceDependencies
> {
  const database = protocolDatabase();
  if (!database) {
    throw new Error("Provider source database is not configured");
  }
  const authoring = new PostgresAuthoringStore(database);

  return {
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    resolveTarget,
    authorizeTarget: async (
      target: ProviderSourceTarget,
    ): Promise<TargetAuthorization> => {
      const result = (await sql<{
        scope_present: boolean;
        grant_active: boolean;
      }>`select
          exists (
            select 1
            from projects p
            join packets r
              on r.workspace_id = p.workspace_id
              and r.project_id = p.id
            where p.workspace_id = ${target.workspaceId}
              and p.id = ${target.projectId}
              and r.id = ${target.requestId}
          ) as scope_present,
          exists (
            select 1
            from grants g
            where g.workspace_id = ${target.workspaceId}
              and g.project_id = ${target.projectId}
              and g.actor_id = ${target.providerActorId}
              and g.action = ${target.grantAction}
              and g.epoch = ${target.grantEpoch}
              and g.active = true
          ) as grant_active`
        .execute(database.kysely)).rows[0];
      if (!result?.scope_present) return "scope-not-found";
      return result.grant_active ? "authorized" : "grant-required";
    },
    listSourceIntake: async (target) => {
      const prefix = `${providerSourceScopePrefix(target)}%`;
      const keys = (await sql<{
        source_id: string;
        source_version: number;
      }>`select source_id,source_version
        from source_intake_records
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and source_id like ${prefix}
        order by recorded_at desc,source_id collate "C",source_version desc`
        .execute(database.kysely)).rows;
      const sources = [];
      for (const key of keys) {
        const source = await authoring.readSourceIntake({
          workspaceId: target.workspaceId,
          projectId: target.projectId,
          sourceId: key.source_id,
          version: key.source_version,
        });
        if (source) sources.push(source);
      }
      return Object.freeze(sources);
    },
    putSourceObject: async (input) =>
      (await providerSourceStorage()).put(input),
    persistSourceIntake: (input) => authoring.recordSourceIntake(input),
    now: () => new Date(),
  };
}

import { randomUUID } from "node:crypto";
import {
  PostgresAuthoringStore,
  sql,
  type ProviderDraftRecord,
  type ProviderProjectRecord,
  type ProviderRequestRecord,
} from "@scopeledger/db";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  formatProviderSourceLocator,
  parseProviderSourceLocator,
  providerSourceDisplayReference,
  providerSourceScopePrefix,
} from "../sources/service";
import type {
  AuthoringDependencies,
  AuthoringDraft,
  AuthoringProject,
  AuthoringRequest,
} from "./service";

const workspaceId = "demo-workspace";
const authorityProjectId = "cedar-roastery";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;
const clientId = "cedar-client";
const approverId = "cedar-approver";

function database() {
  const current = protocolDatabase();
  if (!current) {
    throw Object.assign(new Error("AUTHORING_DATABASE_UNAVAILABLE"), {
      code: "AUTHORING_DATABASE_UNAVAILABLE",
    });
  }
  return current;
}

function projectDto(record: ProviderProjectRecord): AuthoringProject {
  return Object.freeze({
    projectId: record.projectId,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
  });
}

function requestDto(record: ProviderRequestRecord): AuthoringRequest {
  return Object.freeze({
    projectId: record.projectId,
    requestId: record.requestId,
    title: record.title,
    createdAt: record.createdAt.toISOString(),
  });
}

type CorrectionContext = AuthoringDraft["correctionContexts"][number];

function correctionClaim(value: unknown): Pick<
  CorrectionContext,
  "statement" | "claimedSourceType" | "sourceAvailability"
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      statement: "Correction concern",
      claimedSourceType: "Client-reported context",
      sourceAvailability: "unavailable",
    };
  }
  const claim = value as Record<string, unknown>;
  const source = claim.source;
  return {
    statement: typeof claim.statement === "string"
      ? claim.statement
      : "Correction concern",
    claimedSourceType: typeof claim.claimedSourceType === "string"
      ? claim.claimedSourceType
      : "Client-reported context",
    sourceAvailability: source
      && typeof source === "object"
      && !Array.isArray(source)
      && (source as Record<string, unknown>).availability === "available"
      ? "available"
      : "unavailable",
  };
}

async function correctionContexts(
  record: ProviderDraftRecord,
): Promise<readonly CorrectionContext[]> {
  const rows = (await sql<{
    concern_id: string;
    unit_version: number;
    assessment_revision: number;
    response_revision: number;
    provider_response: string;
    source_review: string;
    assessed_at: Date;
    claim: unknown;
  }>`select a.concern_id,a.unit_version,a.assessment_revision,
      a.response_revision,a.provider_response,a.source_review,a.assessed_at,
      c.claim
    from provider_reconciliation_assessments a
    join corrections c
      on c.workspace_id = a.workspace_id
      and c.project_id = a.project_id
      and c.id = a.concern_id
    where a.workspace_id = ${record.workspaceId}
      and a.project_id = ${record.projectId}
      and a.request_id = ${record.requestId}
      and a.unit_id = ${record.unitId}
      and a.applicability = 'material-change'
      and a.draft_revision <= ${record.revision}
      and a.assessment_revision = (
        select max(a2.assessment_revision)::integer
        from provider_reconciliation_assessments a2
        where a2.workspace_id = a.workspace_id
          and a2.project_id = a.project_id
          and a2.concern_id = a.concern_id
      )
    order by a.assessed_at,a.concern_id collate "C"`
    .execute(database().kysely)).rows;
  return Object.freeze(rows.map((row) => {
    const claim = correctionClaim(row.claim);
    return Object.freeze({
      concernId: row.concern_id,
      sourceVersion: row.unit_version,
      assessmentRevision: row.assessment_revision,
      responseRevision: row.response_revision,
      ...claim,
      providerResponse: row.provider_response,
      sourceReview: row.source_review,
      assessedAt: row.assessed_at.toISOString(),
    });
  }));
}

function draftDto(
  record: ProviderDraftRecord,
  contexts: readonly CorrectionContext[] = [],
): AuthoringDraft {
  return Object.freeze({
    projectId: record.projectId,
    requestId: record.requestId,
    unitId: record.unitId,
    revision: record.revision,
    state: record.state,
    title: record.title,
    summary: record.summary,
    scope: record.scope,
    exclusions: record.exclusions,
    sourceReferences: record.sourceReferences.map((source) => Object.freeze({
      locator: formatProviderSourceLocator(source),
      displayReference: providerSourceDisplayReference(source),
      version: source.version,
    })),
    correctionContexts: contexts,
    draftReference: record.draftDigest.slice(0, 12).toUpperCase(),
    createdAt: record.createdAt.toISOString(),
  });
}

function store() {
  return new PostgresAuthoringStore(database());
}

export function authoringDependencies(): AuthoringDependencies {
  return {
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    authorize: async ({ action, projectId }) => {
      const targetProjectId = projectId ?? authorityProjectId;
      const result = await sql`select 1 from grants
        where workspace_id = ${workspaceId}
          and project_id = ${targetProjectId}
          and actor_id = ${providerActorId}
          and action = ${action}
          and epoch = ${providerGrantEpoch}
          and active = true
        limit 1`.execute(database().kysely);
      return result.rows.length === 1;
    },
    listProjects: async () => {
      const current = database();
      const ids = (await sql<{ id: string }>`select p.id
        from projects p
        join grants g
          on g.workspace_id = p.workspace_id
          and g.project_id = p.id
          and g.actor_id = ${providerActorId}
          and g.action = 'inspect'
          and g.epoch = ${providerGrantEpoch}
          and g.active = true
        where p.workspace_id = ${workspaceId}
          and p.provider_creation_digest is not null
        order by p.provider_created_at desc, p.id collate "C"`
        .execute(current.kysely)).rows;
      const authoring = new PostgresAuthoringStore(current);
      const projects: AuthoringProject[] = [];
      for (const { id } of ids) {
        const project = await authoring.readProject({
          workspaceId,
          projectId: id,
        });
        if (project) projects.push(projectDto(project));
      }
      return Object.freeze(projects);
    },
    createProject: async ({ displayName }) => {
      const current = database();
      const projectId = `project-${randomUUID()}`;
      const created = await new PostgresAuthoringStore(current).createProject({
        workspaceId,
        projectId,
        displayName,
        clientId,
        initialApproverId: approverId,
        createdBy: providerActorId,
      });
      await current.transaction(async (transaction) => {
        for (const action of ["inspect", "publish"] as const) {
          await sql`insert into grants(
              workspace_id,project_id,actor_id,action,active
            ) values (
              ${workspaceId},${projectId},${providerActorId},${action},true
            )
            on conflict (workspace_id,project_id,actor_id,action)
            do update set active = true`
            .execute(transaction);
        }
      });
      return projectDto(created.project);
    },
    listRequests: async ({ projectId }) => {
      const current = database();
      const ids = (await sql<{ id: string }>`select id from packets
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and provider_creation_digest is not null
        order by provider_created_at desc, id collate "C"`
        .execute(current.kysely)).rows;
      const authoring = new PostgresAuthoringStore(current);
      const requests: AuthoringRequest[] = [];
      for (const { id } of ids) {
        const request = await authoring.readRequest({
          workspaceId,
          projectId,
          requestId: id,
        });
        if (request) requests.push(requestDto(request));
      }
      return Object.freeze(requests);
    },
    createRequest: async ({ projectId, title }) => {
      const created = await store().createRequest({
        workspaceId,
        projectId,
        requestId: `request-${randomUUID()}`,
        title,
        createdBy: providerActorId,
      });
      return requestDto(created.request);
    },
    listDrafts: async ({ projectId, requestId }) => {
      const current = database();
      const keys = (await sql<{ unit_id: string; revision: number }>`
        select unit_id,revision from provider_authoring_draft_versions
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and request_id = ${requestId}
        order by created_at,unit_id collate "C",revision`
        .execute(current.kysely)).rows;
      const authoring = new PostgresAuthoringStore(current);
      const drafts: AuthoringDraft[] = [];
      for (const key of keys) {
        const draft = await authoring.readDraft({
          workspaceId,
          projectId,
          requestId,
          unitId: key.unit_id,
          revision: key.revision,
        });
        if (draft) {
          drafts.push(draftDto(draft, await correctionContexts(draft)));
        }
      }
      return Object.freeze(drafts);
    },
    resolveSourceLocators: async ({
      projectId,
      requestId,
      locators,
    }) => {
      const current = database();
      const authoring = new PostgresAuthoringStore(current);
      const expectedPrefix = providerSourceScopePrefix({
        workspaceId,
        projectId,
        requestId,
      });
      const references = [];
      for (const locator of locators) {
        const parsed = parseProviderSourceLocator(locator);
        if (!parsed) {
          throw Object.assign(new Error("STALE_SOURCE_SELECTION"), {
            code: "STALE_SOURCE_SELECTION",
          });
        }
        if (!parsed.sourceId.startsWith(expectedPrefix)) {
          throw Object.assign(new Error("SOURCE_SCOPE_MISMATCH"), {
            code: "SOURCE_SCOPE_MISMATCH",
          });
        }
        const source = await authoring.readSourceIntake({
          workspaceId,
          projectId,
          sourceId: parsed.sourceId,
          version: parsed.version,
        });
        if (!source || source.availability !== "available") {
          throw Object.assign(new Error("STALE_SOURCE_SELECTION"), {
            code: "STALE_SOURCE_SELECTION",
          });
        }
        references.push(Object.freeze(parsed));
      }
      return Object.freeze(references);
    },
    createDraft: async ({
      projectId,
      requestId,
      unitId: suppliedUnitId,
      title,
      summary,
      scope,
      exclusions,
      sourceReferences,
      reviewReady,
    }) => {
      const current = database();
      const unitId = suppliedUnitId ?? `unit-${randomUUID()}`;
      const latest = (await sql<{ revision: number | null }>`
        select max(revision)::integer as revision
        from provider_authoring_draft_versions
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and request_id = ${requestId}
          and unit_id = ${unitId}`
        .execute(current.kysely)).rows[0]?.revision ?? null;
      if (suppliedUnitId !== null && latest === null) {
        throw Object.assign(new Error("AUTHORING_DRAFT_NOT_FOUND"), {
          code: "NOT_FOUND",
        });
      }
      const saved = await new PostgresAuthoringStore(current).saveDraft({
        workspaceId,
        projectId,
        requestId,
        unitId,
        revision: (latest ?? 0) + 1,
        expectedPreviousRevision: latest,
        state: reviewReady ? "ready-for-client-review" : "in-progress",
        title,
        summary,
        scope,
        exclusions,
        sourceReferences,
        authoredBy: providerActorId,
      });
      return draftDto(
        saved.draft,
        await correctionContexts(saved.draft),
      );
    },
  };
}

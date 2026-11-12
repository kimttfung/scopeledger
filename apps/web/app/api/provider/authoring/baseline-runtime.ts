import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PostgresAuthoringStore,
  readProviderBaselineConfirmation,
  sql,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  parseProviderSourceLocator,
  providerSourceDisplayReference,
  providerSourceScopePrefix,
} from "../sources/service";
import type {
  BaselineDependencies,
  BaselinePreview,
} from "./baseline-service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;

function database() {
  const current = protocolDatabase();
  if (!current) {
    throw Object.assign(new Error("BASELINE_DATABASE_UNAVAILABLE"), {
      code: "BASELINE_DATABASE_UNAVAILABLE",
    });
  }
  return current;
}

function secret(): string {
  const value = process.env.ACCESS_SESSION_SECRET;
  if (!value || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw Object.assign(new Error("BASELINE_SECRET_UNAVAILABLE"), {
      code: "BASELINE_SECRET_UNAVAILABLE",
    });
  }
  return value;
}

function hmac(
  key: string,
  namespace: string,
  parts: readonly (string | number)[],
): Buffer {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update([namespace, ...parts.map(String)].join("\u0000"), "utf8")
    .digest();
}

function derivedUuid(
  key: string,
  namespace: string,
  parts: readonly (string | number)[],
): string {
  const bytes = hmac(key, namespace, parts).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

async function sourcePreview(
  input: Readonly<{
    projectId: string;
    requestId: string;
    sourceLocator: string;
    requireLatest: boolean;
  }>,
): Promise<BaselinePreview> {
  const parsed = parseProviderSourceLocator(input.sourceLocator);
  const prefix = providerSourceScopePrefix({
    workspaceId,
    projectId: input.projectId,
    requestId: input.requestId,
  });
  if (!parsed || !parsed.sourceId.startsWith(prefix)) {
    throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
  }
  const current = database();
  const source = await new PostgresAuthoringStore(current).readSourceIntake({
    workspaceId,
    projectId: input.projectId,
    sourceId: parsed.sourceId,
    version: parsed.version,
  });
  if (!source) {
    throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
  }
  const latest = (await sql<{ version: number }>`select max(version)::integer as version
    from source_versions
    where workspace_id = ${workspaceId}
      and project_id = ${input.projectId}
      and id = ${parsed.sourceId}`.execute(current.kysely)).rows[0]?.version;
  if (input.requireLatest && latest !== parsed.version) {
    throw Object.assign(new Error("STALE_CONTEXT"), {
      code: "STALE_CONTEXT",
    });
  }
  const existing = await readProviderBaselineConfirmation(current.kysely, {
    workspaceId,
    projectId: input.projectId,
    sourceId: parsed.sourceId,
    sourceVersion: parsed.version,
  });
  const confirmationAllowed = source.availability === "available"
    && source.provenance.acceptance.kind === "provider-attested-import"
    && source.permissions.studioSharing === "permitted";
  const key = secret();
  return Object.freeze({
    previewLocator: `slbp1_${hmac(
      key,
      "scopeledger.provider-baseline-preview.v1",
      [
        workspaceId,
        input.projectId,
        input.requestId,
        parsed.sourceId,
        parsed.version,
        source.recordDigest,
        source.availability,
        source.provenance.acceptance.kind,
        source.provenance.acceptance.basis,
        source.permissions.studioSharing,
      ],
    ).toString("base64url")}`,
    sourceLocator: input.sourceLocator,
    displayReference: providerSourceDisplayReference(parsed),
    originalName: source.originalName,
    mediaType: source.mediaType,
    provenanceOrigin: source.provenance.origin,
    originReference: source.provenance.originReference,
    acceptance: source.provenance.acceptance,
    studioSharing: source.permissions.studioSharing,
    confirmationAllowed,
    alreadyConfirmed: existing !== null,
    confirmedAt: existing?.confirmedAt.toISOString() ?? null,
  });
}

export function baselineDependencies(): BaselineDependencies {
  return Object.freeze({
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    authorize: async (projectId, requestId) => {
      const current = database();
      const result = (await sql<{
        scope_present: boolean;
        grant_active: boolean;
      }>`select
          exists (
            select 1 from projects p
            join packets r
              on r.workspace_id = p.workspace_id
              and r.project_id = p.id
            where p.workspace_id = ${workspaceId}
              and p.id = ${projectId}
              and r.id = ${requestId}
              and p.provider_creation_digest is not null
          ) as scope_present,
          exists (
            select 1 from grants g
            where g.workspace_id = ${workspaceId}
              and g.project_id = ${projectId}
              and g.actor_id = ${providerActorId}
              and g.action = 'publish'
              and g.epoch = ${providerGrantEpoch}
              and g.active = true
          ) as grant_active`.execute(current.kysely)).rows[0];
      if (!result?.scope_present) return "not-found";
      return result.grant_active ? "authorized" : "grant-required";
    },
    previewBaseline: (input) => sourcePreview({
      ...input,
      requireLatest: true,
    }),
    confirmBaseline: async (input) => {
      const preview = await sourcePreview({
        ...input,
        requireLatest: false,
      });
      if (!safeEqual(preview.previewLocator, input.previewLocator)) {
        throw Object.assign(new Error("STALE_CONTEXT"), {
          code: "STALE_CONTEXT",
        });
      }
      if (!preview.confirmationAllowed) {
        throw Object.assign(new Error("REVIEW_HOLD"), {
          code: "REVIEW_HOLD",
        });
      }
      const parsed = parseProviderSourceLocator(input.sourceLocator);
      if (!parsed) {
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }
      const key = secret();
      const result = await new OrderedConsentStore(database())
        .confirmProviderBaseline({
          workspaceId,
          projectId: input.projectId,
          actorId: providerActorId,
          grantEpoch: providerGrantEpoch,
        }, {
          commandId: derivedUuid(
            key,
            "scopeledger.provider-baseline-command.v1",
            [
              workspaceId,
              input.projectId,
              input.requestId,
              parsed.sourceId,
              parsed.version,
              input.idempotencyKey,
            ],
          ),
          requestId: input.requestId,
          sourceId: parsed.sourceId,
          sourceVersion: parsed.version,
        });
      const confirmation = await readProviderBaselineConfirmation(
        database().kysely,
        {
          workspaceId,
          projectId: input.projectId,
          sourceId: parsed.sourceId,
          sourceVersion: parsed.version,
        },
      );
      if (!confirmation) {
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }
      return Object.freeze({
        displayReference: preview.displayReference,
        baselineVersion: result.baselineVersion,
        confirmedAt: confirmation.confirmedAt.toISOString(),
        duplicate: preview.alreadyConfirmed,
      });
    },
  });
}

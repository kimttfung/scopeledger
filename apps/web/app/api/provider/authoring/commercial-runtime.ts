import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  PostgresAuthoringStore,
  readCommercialPreparation,
  readPublicationProvenance,
  sql,
  type CommercialPreparationRecord,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import {
  ReviewLocatorCodec,
} from "../../review/service";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  parseProviderSourceLocator,
  providerSourceDisplayReference,
} from "../sources/service";
import type {
  CommercialDependencies,
  CommercialPreparationInput,
  CommercialPreparationPreview,
} from "./commercial-service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;
const locatorPattern = /^slcp1_[A-Za-z0-9_-]{43}$/u;

function database() {
  const current = protocolDatabase();
  if (!current) {
    throw Object.assign(new Error("AUTHORING_DATABASE_UNAVAILABLE"), {
      code: "AUTHORING_DATABASE_UNAVAILABLE",
    });
  }
  return current;
}

function secret(): string {
  const value = process.env.ACCESS_SESSION_SECRET;
  if (!value || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw Object.assign(new Error("AUTHORING_SECRET_UNAVAILABLE"), {
      code: "AUTHORING_SECRET_UNAVAILABLE",
    });
  }
  return value;
}

function actor(projectId: string) {
  return Object.freeze({
    workspaceId,
    projectId,
    actorId: providerActorId,
    grantEpoch: providerGrantEpoch,
  });
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

function preparationLocator(
  key: string,
  input: Readonly<{
    projectId: string;
    requestId: string;
    unitId: string;
    draftRevision: number;
    preparationId: string;
  }>,
): string {
  return `slcp1_${hmac(key, "scopeledger.provider-preparation.v1", [
    workspaceId,
    input.projectId,
    input.requestId,
    input.unitId,
    input.draftRevision,
    input.preparationId,
  ]).toString("base64url")}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function exactMoney(
  amount: string,
  taxAmount: string,
  treatment: CommercialPreparationInput["tax"]["treatment"],
): string {
  const subtotal = BigInt(amount.replace(".", ""));
  const tax = BigInt(taxAmount.replace(".", ""));
  const gross = treatment === "exclusive" ? subtotal + tax : subtotal;
  if (gross > 999_999_999_999n) {
    throw Object.assign(new Error("INVALID_INPUT"), { code: "INVALID_INPUT" });
  }
  return `${gross / 100n}.${String(gross % 100n).padStart(2, "0")}`;
}

function preview(
  key: string,
  preparation: CommercialPreparationRecord,
  draft: NonNullable<Awaited<ReturnType<PostgresAuthoringStore["readDraft"]>>>,
): CommercialPreparationPreview {
  const price = preparation.price;
  return Object.freeze({
    preparationLocator: preparationLocator(key, preparation),
    revision: preparation.revision,
    draftRevision: preparation.draftRevision,
    treatment: preparation.treatment,
    publicationReadiness: preparation.publicationReadiness,
    publicationAllowed: preparation.publicationReadiness === "ready"
      && (
        preparation.treatment === "waived"
        || preparation.treatment === "payable"
      ),
    preparedAt: preparation.preparedAt.toISOString(),
    draft: Object.freeze({
      title: draft.title,
      summary: draft.summary,
      scope: draft.scope,
      exclusions: draft.exclusions,
      sources: Object.freeze(preparation.sourceCoverage.map((coverage) =>
        Object.freeze({
          displayReference: providerSourceDisplayReference({
            sourceId: coverage.sourceId,
            version: coverage.version,
          }),
          locator: coverage.locator,
          materiality: coverage.materiality,
          coverageStatus: coverage.coverageStatus,
          analysisStatus: coverage.analysisStatus,
          analysisReference: coverage.analysisReference,
          explanation: coverage.explanation,
        }))),
    }),
    terms: Object.freeze({
      independenceExplanation: preparation.independenceExplanation,
      dependencies: Object.freeze(preparation.dependencies.map((dependency) =>
        Object.freeze({ explanation: dependency.explanation }))),
      clientVisibleRationale: preparation.clientVisibleRationale,
      delivery: preparation.delivery,
      prerequisites: preparation.prerequisites,
      consentRequirement: preparation.consentRequirement,
      paymentExplanation: preparation.paymentExplanation,
      tax: preparation.tax,
      price: price
        ? Object.freeze({
          currency: price.currency,
          paymentPolicy: price.paymentPolicy,
          description: price.lines[0]!.description,
          amount: price.subtotal,
          gross: price.gross,
        })
        : null,
    }),
  });
}

async function resolvePreparation(
  key: string,
  input: Readonly<{
    projectId: string;
    requestId: string;
    unitId: string;
    draftRevision: number;
    preparationLocator: string;
  }>,
): Promise<CommercialPreparationRecord> {
  if (!locatorPattern.test(input.preparationLocator)) {
    throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
  }
  const current = database();
  const ids = (await sql<{ preparation_id: string }>`
    select preparation_id::text
    from provider_commercial_preparations
    where workspace_id = ${workspaceId}
      and project_id = ${input.projectId}
      and request_id = ${input.requestId}
      and unit_id = ${input.unitId}
      and draft_revision = ${input.draftRevision}
    order by revision desc
  `.execute(current.kysely)).rows;
  for (const row of ids) {
    const candidate = preparationLocator(key, {
      ...input,
      preparationId: row.preparation_id,
    });
    if (!safeEqual(candidate, input.preparationLocator)) continue;
    const record = await readCommercialPreparation(current.kysely, {
      workspaceId,
      projectId: input.projectId,
      preparationId: row.preparation_id,
    });
    if (record) return record;
  }
  throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
}

export function commercialDependencies(): CommercialDependencies {
  return Object.freeze({
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    authorize: async (projectId) => {
      const result = await sql`select 1 from grants
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and actor_id = ${providerActorId}
          and action = 'publish'
          and epoch = ${providerGrantEpoch}
          and active = true
        limit 1`.execute(database().kysely);
      return result.rows.length === 1;
    },
    prepareCommercial: async (input) => {
      const current = database();
      const key = secret();
      const confirmedBaselines = (await sql<{ count: number }>`
        select count(*)::integer as count
        from provider_baseline_confirmations
        where workspace_id = ${workspaceId}
          and project_id = ${input.projectId}
      `.execute(current.kysely)).rows[0]?.count ?? 0;
      if (confirmedBaselines < 1) {
        throw Object.assign(new Error("BASELINE_REQUIRED"), {
          code: "BASELINE_REQUIRED",
        });
      }
      const authoring = new PostgresAuthoringStore(current);
      const draft = await authoring.readDraft({
        workspaceId,
        projectId: input.projectId,
        requestId: input.requestId,
        unitId: input.unitId,
        revision: input.draftRevision,
      });
      if (!draft) {
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }
      if (
        draft.sourceReferences.length !== input.sourceCoverage.length
      ) {
        throw Object.assign(new Error("INVALID_INPUT"), {
          code: "INVALID_INPUT",
        });
      }
      const sourceCoverage = input.sourceCoverage.map((coverage, index) => {
        const parsed = parseProviderSourceLocator(coverage.sourceLocator);
        const reference = draft.sourceReferences[index];
        if (
          !parsed
          || !reference
          || parsed.sourceId !== reference.sourceId
          || parsed.version !== reference.version
        ) {
          throw Object.assign(new Error("INVALID_INPUT"), {
            code: "INVALID_INPUT",
          });
        }
        return Object.freeze({
          sourceId: parsed.sourceId,
          version: parsed.version,
          locator: coverage.locator,
          materiality: coverage.materiality,
          coverageStatus: coverage.coverageStatus,
          analysisStatus: coverage.analysisStatus,
          analysisReference: coverage.analysisReference,
          explanation: coverage.explanation,
        });
      });
      const commandId = derivedUuid(
        key,
        "scopeledger.provider-preparation-command.v1",
        [
          workspaceId,
          input.projectId,
          input.requestId,
          input.unitId,
          input.draftRevision,
          input.idempotencyKey,
        ],
      );
      const preparationId = derivedUuid(
        key,
        "scopeledger.provider-preparation.v1",
        [
          workspaceId,
          input.projectId,
          input.requestId,
          input.unitId,
          input.draftRevision,
          input.idempotencyKey,
        ],
      );
      const price = input.price
        ? {
          currency: "USD" as const,
          paymentPolicy: "full-prepayment" as const,
          lines: [{
            id: "commercial-unit",
            description: input.price.description,
            quantity: "1",
            unitPrice: input.price.amount,
            amount: input.price.amount,
          }],
          subtotal: input.price.amount,
          gross: exactMoney(
            input.price.amount,
            input.tax.amount,
            input.tax.treatment,
          ),
        }
        : null;
      await new OrderedConsentStore(current).prepareCommercial(
        actor(input.projectId),
        {
          commandId,
          preparationId,
          requestId: input.requestId,
          unitId: input.unitId,
          draftRevision: input.draftRevision,
          treatment: input.treatment,
          independenceExplanation: input.independenceExplanation,
          dependencies: input.dependencies,
          clientVisibleRationale: input.clientVisibleRationale,
          delivery: input.delivery,
          prerequisites: input.prerequisites,
          consentRequirement: input.consentRequirement,
          paymentExplanation: input.paymentExplanation,
          tax: input.tax,
          price,
          sourceCoverage,
        },
      );
      const prepared = await readCommercialPreparation(current.kysely, {
        workspaceId,
        projectId: input.projectId,
        preparationId,
      });
      if (!prepared) {
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }
      return preview(key, prepared, draft);
    },
    publishCommercial: async (input) => {
      const current = database();
      const key = secret();
      const preparation = await resolvePreparation(key, input);
      const commandId = derivedUuid(
        key,
        "scopeledger.provider-publication-command.v1",
        [
          workspaceId,
          input.projectId,
          input.requestId,
          input.unitId,
          input.draftRevision,
          input.idempotencyKey,
        ],
      );
      const published = await new OrderedConsentStore(current).publishPrepared(
        actor(input.projectId),
        {
          commandId,
          preparationId: preparation.preparationId,
        },
      );
      const provenance = await readPublicationProvenance(current.kysely, {
        workspaceId,
        projectId: input.projectId,
        preparationId: preparation.preparationId,
      });
      if (!provenance) {
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }
      const codec = new ReviewLocatorCodec(key);
      const projectLocator = codec.project(workspaceId, input.projectId);
      const requestLocator = codec.request(
        workspaceId,
        input.projectId,
        input.requestId,
      );
      const unitLocator = codec.unit(
        workspaceId,
        input.projectId,
        input.requestId,
        input.unitId,
      );
      return Object.freeze({
        treatment: preparation.treatment as "waived" | "payable",
        version: published.version,
        publishedAt: provenance.publishedAt.toISOString(),
        review: Object.freeze({
          projectLocator,
          requestLocator,
          unitLocator,
          url: `/review/${projectLocator}/${requestLocator}/${unitLocator}`,
        }),
      });
    },
  });
}

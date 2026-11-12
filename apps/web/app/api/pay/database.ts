import { timingSafeEqual } from "node:crypto";
import {
  sql,
  type ProtocolDatabase,
  type ProtocolTransaction,
} from "@scopeledger/db";
import {
  freezePublishedUnit,
  type Payer,
  type PublishedUnit,
} from "@scopeledger/contracts";
const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const payerActorId = "cedar-payer";
const MAX_LOCATOR_CANDIDATES = 256;

export type ReviewLocators = Readonly<{
  projectLocator: string;
  requestLocator: string;
  unitLocator: string;
}>;

export type PaymentLocators = ReviewLocators & Readonly<{
  payerLocator: string;
}>;

type PaymentLocatorCodec = Readonly<{
  project: (workspaceId: string, projectId: string) => string;
  request: (
    workspaceId: string,
    projectId: string,
    requestId: string,
  ) => string;
  unit: (
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
  ) => string;
  matchesProject: (
    candidate: string,
    workspaceId: string,
    projectId: string,
  ) => boolean;
  matchesRequest: (
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
  ) => boolean;
  matchesUnit: (
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
  ) => boolean;
  matchesPayer: (
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
    version: number,
    digest: string,
    obligationId: string,
    payerId: string,
  ) => boolean;
}>;

export type ApprovedPaymentTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  version: number;
  digest: string;
  obligationId: string;
  projectNominationEpoch: number;
  providerInspectGrantEpoch: number;
  providerPublishGrantEpoch: number;
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  currency: "USD";
  gross: string;
  payer: Payer | null;
  activatedAt: string | null;
}>;

export class CustomPaymentLoadError extends Error {
  constructor(
    public readonly code:
      | "ACCESS_DENIED"
      | "NOT_FOUND"
      | "STALE_RECORD"
      | "MALFORMED_RECORD",
  ) {
    super(code);
    this.name = "CustomPaymentLoadError";
  }
}

type TargetRow = Readonly<{
  project_id: string;
  project_label: string | null;
  client_id: string;
  approver_id: string;
  nomination_epoch: number;
  context_revision: number;
  provider_inspect_epoch: number;
  provider_publish_epoch: number;
  request_id: string;
  request_label: string | null;
  unit_id: string;
  current_version: number;
  accepted_version: number;
  snapshot: unknown;
  canonical_bytes: Buffer;
  digest: string;
  obligation_id: string;
  merchant_id: string;
  environment: "sandbox" | "live";
  currency: "USD";
  gross: string;
  collectible: boolean;
  payer_grant_epoch: number | null;
  payer_grant_active: boolean | null;
  payer_actor_id: string | null;
  payer_epoch: number | null;
  payer_continuity_epoch: number | null;
  payer_active: boolean | null;
  activated_at: Date | null;
}>;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function opaqueFallback(prefix: string, locator: string): string {
  return `${prefix} · ${locator.slice(-8).toUpperCase()}`;
}

async function bounded<T>(rows: Promise<readonly T[]>): Promise<readonly T[]> {
  const resolved = await rows;
  if (resolved.length > MAX_LOCATOR_CANDIDATES) {
    throw new CustomPaymentLoadError("STALE_RECORD");
  }
  return resolved;
}

async function providerProjectIds(
  transaction: ProtocolTransaction,
): Promise<readonly Readonly<{
  project_id: string;
  inspect_epoch: number;
}>[]> {
  return bounded((async () => (await sql<{
    project_id: string;
    inspect_epoch: number;
  }>`select p.id as project_id,inspect_grant.epoch as inspect_epoch
    from projects p
    join grants inspect_grant
      on inspect_grant.workspace_id = p.workspace_id
      and inspect_grant.project_id = p.id
      and inspect_grant.actor_id = ${providerActorId}
      and inspect_grant.action = 'inspect'
      and inspect_grant.active = true
    join grants publish_grant
      on publish_grant.workspace_id = p.workspace_id
      and publish_grant.project_id = p.id
      and publish_grant.actor_id = ${providerActorId}
      and publish_grant.action = 'publish'
      and publish_grant.active = true
    where p.workspace_id = ${workspaceId}
    order by p.id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
}

async function targetRows(
  transaction: ProtocolTransaction,
  projectId: string,
): Promise<readonly TargetRow[]> {
  return bounded((async () => (await sql<TargetRow>`select
      p.id as project_id,p.provider_display_name as project_label,
      p.client_id,p.approver_id,p.nomination_epoch,p.context_revision,
      inspect_grant.epoch as provider_inspect_epoch,
      publish_grant.epoch as provider_publish_epoch,
      packet.id as request_id,packet.provider_title as request_label,
      unit.id as unit_id,unit.current_version,unit.accepted_version,
      version.snapshot,version.canonical_bytes,version.digest,
      obligation.id as obligation_id,obligation.merchant_id,
      obligation.environment,obligation.currency,obligation.gross,
      obligation.collectible,pay_grant.epoch as payer_grant_epoch,
      pay_grant.active as payer_grant_active,
      nomination.actor_id as payer_actor_id,
      nomination.epoch as payer_epoch,
      nomination.continuity_epoch as payer_continuity_epoch,
      nomination.active as payer_active,
      (
        select history.recorded_at
        from protocol_history history
        where history.workspace_id = p.workspace_id
          and history.project_id = p.id
          and history.event = 'local-payer-authority-activated'
          and history.resource_id = obligation.id
        order by history.sequence
        limit 1
      ) as activated_at
    from projects p
    join grants inspect_grant
      on inspect_grant.workspace_id = p.workspace_id
      and inspect_grant.project_id = p.id
      and inspect_grant.actor_id = ${providerActorId}
      and inspect_grant.action = 'inspect'
      and inspect_grant.active = true
    join grants publish_grant
      on publish_grant.workspace_id = p.workspace_id
      and publish_grant.project_id = p.id
      and publish_grant.actor_id = ${providerActorId}
      and publish_grant.action = 'publish'
      and publish_grant.active = true
    join packets packet
      on packet.workspace_id = p.workspace_id
      and packet.project_id = p.id
    join units unit
      on unit.workspace_id = packet.workspace_id
      and unit.project_id = packet.project_id
      and unit.packet_id = packet.id
      and unit.current_version is not null
      and unit.accepted_version = unit.current_version
    join unit_versions version
      on version.workspace_id = unit.workspace_id
      and version.project_id = unit.project_id
      and version.unit_id = unit.id
      and version.version = unit.current_version
    join decisions decision
      on decision.workspace_id = unit.workspace_id
      and decision.project_id = unit.project_id
      and decision.unit_id = unit.id
      and decision.version = unit.accepted_version
      and decision.decision = 'approve'
    join obligations obligation
      on obligation.workspace_id = decision.workspace_id
      and obligation.project_id = decision.project_id
      and obligation.unit_id = decision.unit_id
      and obligation.version = decision.version
      and obligation.collectible = true
    left join grants pay_grant
      on pay_grant.workspace_id = p.workspace_id
      and pay_grant.project_id = p.id
      and pay_grant.actor_id = ${payerActorId}
      and pay_grant.action = 'pay'
    left join payer_nominations nomination
      on nomination.workspace_id = obligation.workspace_id
      and nomination.project_id = obligation.project_id
      and nomination.obligation_id = obligation.id
    where p.workspace_id = ${workspaceId}
      and p.id = ${projectId}
    order by packet.id collate "C",unit.id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
}

function verifiedSnapshot(row: TargetRow): PublishedUnit {
  let frozen;
  try {
    frozen = freezePublishedUnit(row.snapshot);
  } catch {
    throw new CustomPaymentLoadError("MALFORMED_RECORD");
  }
  if (
    frozen.digest !== row.digest
    || !frozen.bytes.equals(row.canonical_bytes)
    || frozen.snapshot.workspaceId !== workspaceId
    || frozen.snapshot.projectId !== row.project_id
    || frozen.snapshot.clientId !== row.client_id
    || frozen.snapshot.approver.actorId !== row.approver_id
    || frozen.snapshot.approver.nominationEpoch !== row.nomination_epoch
    || frozen.snapshot.contextRevision !== row.context_revision
    || frozen.snapshot.unitId !== row.unit_id
    || frozen.snapshot.version !== row.current_version
    || frozen.snapshot.treatment !== "payable"
    || frozen.snapshot.payment.financial.currency !== row.currency
    || frozen.snapshot.payment.financial.gross !== row.gross
    || frozen.snapshot.payment.financial.merchantId !== row.merchant_id
    || frozen.snapshot.payment.financial.environment !== row.environment
  ) {
    throw new CustomPaymentLoadError("STALE_RECORD");
  }
  return frozen.snapshot;
}

function paymentPayer(row: TargetRow): Payer | null {
  if (
    row.payer_grant_epoch === null
    || row.payer_grant_active !== true
    || row.payer_actor_id !== payerActorId
    || row.payer_epoch === null
    || row.payer_continuity_epoch !== row.nomination_epoch
    || row.payer_active !== true
  ) {
    return null;
  }
  return Object.freeze({
    workspaceId,
    projectId: row.project_id,
    actorId: payerActorId,
    grantEpoch: row.payer_grant_epoch,
    obligationId: row.obligation_id,
    payerEpoch: row.payer_epoch,
    nominationEpoch: row.nomination_epoch,
  });
}

function target(
  locators: ReviewLocators,
  row: TargetRow,
): ApprovedPaymentTarget {
  const snapshot = verifiedSnapshot(row);
  return Object.freeze({
    workspaceId,
    projectId: row.project_id,
    requestId: row.request_id,
    unitId: row.unit_id,
    version: row.current_version,
    digest: row.digest,
    obligationId: row.obligation_id,
    projectNominationEpoch: row.nomination_epoch,
    providerInspectGrantEpoch: row.provider_inspect_epoch,
    providerPublishGrantEpoch: row.provider_publish_epoch,
    projectLabel: row.project_label
      ?? opaqueFallback("Project", locators.projectLocator),
    requestLabel: row.request_label
      ?? opaqueFallback("Request", locators.requestLocator),
    unitTitle: snapshot.title,
    currency: row.currency,
    gross: row.gross,
    payer: paymentPayer(row),
    activatedAt: row.activated_at?.toISOString() ?? null,
  });
}

async function resolveProviderTarget(
  transaction: ProtocolTransaction,
  codec: PaymentLocatorCodec,
  locators: ReviewLocators,
): Promise<ApprovedPaymentTarget> {
  const projects = await providerProjectIds(transaction);
  const project = projects.find((candidate) =>
    codec.matchesProject(
      locators.projectLocator,
      workspaceId,
      candidate.project_id,
    ));
  if (!project) throw new CustomPaymentLoadError("NOT_FOUND");
  const rows = await targetRows(transaction, project.project_id);
  const matches = rows.filter((row) =>
    codec.matchesRequest(
      locators.requestLocator,
      workspaceId,
      row.project_id,
      row.request_id,
    )
    && codec.matchesUnit(
      locators.unitLocator,
      workspaceId,
      row.project_id,
      row.request_id,
      row.unit_id,
    ));
  if (matches.length !== 1) {
    throw new CustomPaymentLoadError(
      matches.length === 0 ? "NOT_FOUND" : "STALE_RECORD",
    );
  }
  return target(locators, matches[0]!);
}

export async function listProviderPaymentTargets(
  input: Readonly<{
    database: ProtocolDatabase;
    codec: PaymentLocatorCodec;
  }>,
): Promise<readonly Readonly<{
  locators: ReviewLocators;
  target: ApprovedPaymentTarget;
}>[]> {
  return input.database.transaction(async (transaction) => {
    const projects = await providerProjectIds(transaction);
    const results: Array<{
      locators: ReviewLocators;
      target: ApprovedPaymentTarget;
    }> = [];
    for (const project of projects) {
      for (const row of await targetRows(transaction, project.project_id)) {
        const locators = Object.freeze({
          projectLocator: input.codec.project(workspaceId, row.project_id),
          requestLocator: input.codec.request(
            workspaceId,
            row.project_id,
            row.request_id,
          ),
          unitLocator: input.codec.unit(
            workspaceId,
            row.project_id,
            row.request_id,
            row.unit_id,
          ),
        });
        results.push({
          locators,
          target: target(locators, row),
        });
      }
    }
    return Object.freeze(results);
  });
}

export function loadProviderPaymentTarget(
  input: Readonly<{
    database: ProtocolDatabase;
    codec: PaymentLocatorCodec;
    locators: ReviewLocators;
  }>,
): Promise<ApprovedPaymentTarget> {
  return input.database.transaction((transaction) =>
    resolveProviderTarget(transaction, input.codec, input.locators));
}

export async function loadPayerPaymentTarget(
  input: Readonly<{
    database: ProtocolDatabase;
    codec: PaymentLocatorCodec;
    locators: PaymentLocators;
    subject: string;
    expectedSubject: string;
  }>,
): Promise<ApprovedPaymentTarget> {
  if (!safeEqual(input.subject, input.expectedSubject)) {
    throw new CustomPaymentLoadError("ACCESS_DENIED");
  }
  const resolved = await input.database.transaction((transaction) =>
    resolveProviderTarget(transaction, input.codec, input.locators));
  if (
    !resolved.payer
    || !input.codec.matchesPayer(
      input.locators.payerLocator,
      resolved.workspaceId,
      resolved.projectId,
      resolved.requestId,
      resolved.unitId,
      resolved.version,
      resolved.digest,
      resolved.obligationId,
      payerActorId,
    )
  ) {
    throw new CustomPaymentLoadError("NOT_FOUND");
  }
  return resolved;
}

export const customPaymentActors = Object.freeze({
  providerActorId,
  payerActorId,
});

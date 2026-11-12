import { timingSafeEqual } from "node:crypto";
import {
  sql,
  type ProtocolDatabase,
  type ProtocolTransaction,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  freezePublishedUnit,
  type PublishedUnit,
} from "@scopeledger/contracts";
import {
  ReviewLoadError,
  ReviewLocatorCodec,
  type ReviewLocators,
  type ReviewProjection,
  type ReviewSession,
} from "./service";
import type {
  ReviewMutationBasis,
  ReviewMutationSession,
} from "./mutation-service";

const reviewPrincipal = Object.freeze({
  workspaceId: "demo-workspace",
  actorId: "cedar-approver",
});
const MAX_LOCATOR_CANDIDATES = 256;
const MAX_VISIBLE_HISTORY = 50;

type ResolvedTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  inspectGrantEpoch: number;
}>;

type MutationResolvedTarget = ResolvedTarget & Readonly<{
  decideGrantEpoch: number;
  correctGrantEpoch: number | null;
  matchedVersion: number;
  matchedDigest: string;
}>;

type TargetRow = Readonly<{
  project_name: string | null;
  request_title: string | null;
  client_id: string;
  approver_id: string;
  nomination_epoch: number;
  context_revision: number;
  unit_id: string;
  current_version: number;
  accepted_version: number | null;
  snapshot: unknown;
  canonical_bytes: Buffer;
  digest: string;
  published_at: Date;
}>;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function iso(value: Date): string {
  return value.toISOString();
}

function opaqueFallback(prefix: string, locator: string): string {
  return `${prefix} · ${locator.slice(-8).toUpperCase()}`;
}

function sourceOrigin(value: string | null): string | null {
  if (!value) return null;
  const labels: Record<string, string> = {
    agreement: "Agreement",
    amendment: "Amendment",
    correspondence: "Correspondence",
    request: "Request",
    "prior-decision": "Prior decision",
    correction: "Correction",
    other: "Other admitted source",
  };
  return labels[value] ?? null;
}

async function boundedRows<T>(
  rows: Promise<readonly T[]>,
): Promise<readonly T[]> {
  const resolved = await rows;
  if (resolved.length > MAX_LOCATOR_CANDIDATES) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  return resolved;
}

async function resolveTarget(
  transaction: ProtocolTransaction,
  codec: ReviewLocatorCodec,
  locators: ReviewLocators,
): Promise<ResolvedTarget> {
  const projects = await boundedRows((async () => (await sql<{
    project_id: string;
    inspect_epoch: number;
  }>`select p.id as project_id,inspect_grant.epoch as inspect_epoch
    from projects p
    join grants decide_grant
      on decide_grant.workspace_id = p.workspace_id
      and decide_grant.project_id = p.id
      and decide_grant.actor_id = p.approver_id
      and decide_grant.action = 'decide'
      and decide_grant.active = true
    join grants inspect_grant
      on inspect_grant.workspace_id = p.workspace_id
      and inspect_grant.project_id = p.id
      and inspect_grant.actor_id = p.approver_id
      and inspect_grant.action = 'inspect'
      and inspect_grant.active = true
    where p.workspace_id = ${reviewPrincipal.workspaceId}
      and p.approver_id = ${reviewPrincipal.actorId}
    order by p.id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
  const project = projects.find((candidate) =>
    codec.matchesProject(
      locators.projectLocator,
      reviewPrincipal.workspaceId,
      candidate.project_id,
    ));
  if (!project) throw new ReviewLoadError("NOT_FOUND");

  const requests = await boundedRows((async () => (await sql<{
    request_id: string;
  }>`select id as request_id from packets
    where workspace_id = ${reviewPrincipal.workspaceId}
      and project_id = ${project.project_id}
    order by id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
  const request = requests.find((candidate) =>
    codec.matchesRequest(
      locators.requestLocator,
      reviewPrincipal.workspaceId,
      project.project_id,
      candidate.request_id,
    ));
  if (!request) throw new ReviewLoadError("NOT_FOUND");

  const units = await boundedRows((async () => (await sql<{
    unit_id: string;
  }>`select id as unit_id from units
    where workspace_id = ${reviewPrincipal.workspaceId}
      and project_id = ${project.project_id}
      and packet_id = ${request.request_id}
      and current_version is not null
    order by id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
  const unit = units.find((candidate) =>
    codec.matchesUnit(
      locators.unitLocator,
      reviewPrincipal.workspaceId,
      project.project_id,
      request.request_id,
      candidate.unit_id,
    ));
  if (!unit) throw new ReviewLoadError("NOT_FOUND");

  return Object.freeze({
    workspaceId: reviewPrincipal.workspaceId,
    projectId: project.project_id,
    requestId: request.request_id,
    unitId: unit.unit_id,
    inspectGrantEpoch: project.inspect_epoch,
  });
}

async function resolveMutationTarget(
  transaction: ProtocolTransaction,
  codec: ReviewLocatorCodec,
  locators: ReviewLocators,
): Promise<MutationResolvedTarget> {
  const projects = await boundedRows((async () => (await sql<{
    project_id: string;
    inspect_epoch: number;
    decide_epoch: number;
    correct_epoch: number | null;
  }>`select p.id as project_id,
      inspect_grant.epoch as inspect_epoch,
      decide_grant.epoch as decide_epoch,
      correct_grant.epoch as correct_epoch
    from projects p
    join grants decide_grant
      on decide_grant.workspace_id = p.workspace_id
      and decide_grant.project_id = p.id
      and decide_grant.actor_id = p.approver_id
      and decide_grant.action = 'decide'
      and decide_grant.active = true
    join grants inspect_grant
      on inspect_grant.workspace_id = p.workspace_id
      and inspect_grant.project_id = p.id
      and inspect_grant.actor_id = p.approver_id
      and inspect_grant.action = 'inspect'
      and inspect_grant.active = true
    left join grants correct_grant
      on correct_grant.workspace_id = p.workspace_id
      and correct_grant.project_id = p.id
      and correct_grant.actor_id = p.approver_id
      and correct_grant.action = 'correct'
      and correct_grant.active = true
    where p.workspace_id = ${reviewPrincipal.workspaceId}
      and p.approver_id = ${reviewPrincipal.actorId}
    order by p.id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
  const project = projects.find((candidate) =>
    codec.matchesProject(
      locators.projectLocator,
      reviewPrincipal.workspaceId,
      candidate.project_id,
    ));
  if (!project) throw new ReviewLoadError("NOT_FOUND");

  const requests = await boundedRows((async () => (await sql<{
    request_id: string;
  }>`select id as request_id from packets
    where workspace_id = ${reviewPrincipal.workspaceId}
      and project_id = ${project.project_id}
    order by id collate "C"
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
  const request = requests.find((candidate) =>
    codec.matchesRequest(
      locators.requestLocator,
      reviewPrincipal.workspaceId,
      project.project_id,
      candidate.request_id,
    ));
  if (!request) throw new ReviewLoadError("NOT_FOUND");

  const versions = await boundedRows((async () => (await sql<{
    unit_id: string;
    current_version: number;
    version: number;
    digest: string;
  }>`select u.id as unit_id,u.current_version,v.version,v.digest
    from units u
    join unit_versions v
      on v.workspace_id = u.workspace_id
      and v.project_id = u.project_id
      and v.unit_id = u.id
    where u.workspace_id = ${reviewPrincipal.workspaceId}
      and u.project_id = ${project.project_id}
      and u.packet_id = ${request.request_id}
      and u.current_version is not null
    order by u.id collate "C",v.version desc
    limit ${MAX_LOCATOR_CANDIDATES + 1}`
    .execute(transaction)).rows)());
  const matched = versions.find((candidate) =>
    codec.matchesMutationUnit(
      locators.unitLocator,
      reviewPrincipal.workspaceId,
      project.project_id,
      request.request_id,
      candidate.unit_id,
      candidate.version,
      candidate.digest,
    ));
  if (!matched) throw new ReviewLoadError("NOT_FOUND");
  if (matched.current_version !== matched.version) {
    throw new ReviewLoadError("STALE_RECORD");
  }

  return Object.freeze({
    workspaceId: reviewPrincipal.workspaceId,
    projectId: project.project_id,
    requestId: request.request_id,
    unitId: matched.unit_id,
    inspectGrantEpoch: project.inspect_epoch,
    decideGrantEpoch: project.decide_epoch,
    correctGrantEpoch: project.correct_epoch,
    matchedVersion: matched.version,
    matchedDigest: matched.digest,
  });
}

function verifiedSnapshot(row: TargetRow): PublishedUnit {
  let frozen;
  try {
    frozen = freezePublishedUnit(row.snapshot);
  } catch {
    throw new ReviewLoadError("MALFORMED_RECORD");
  }
  if (
    frozen.digest !== row.digest
    || !frozen.bytes.equals(row.canonical_bytes)
    || frozen.snapshot.clientId !== row.client_id
    || frozen.snapshot.approver.actorId !== row.approver_id
    || frozen.snapshot.approver.nominationEpoch !== row.nomination_epoch
    || frozen.snapshot.contextRevision !== row.context_revision
    || frozen.snapshot.unitId !== row.unit_id
    || frozen.snapshot.version !== row.current_version
  ) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  return frozen.snapshot;
}

async function loadTargetRow(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
): Promise<TargetRow> {
  const row = (await sql<TargetRow>`select
      p.provider_display_name as project_name,
      r.provider_title as request_title,
      p.client_id,p.approver_id,p.nomination_epoch,p.context_revision,
      u.id as unit_id,u.current_version,u.accepted_version,
      v.snapshot,v.canonical_bytes,v.digest,v.published_at
    from projects p
    join packets r
      on r.workspace_id = p.workspace_id
      and r.project_id = p.id
      and r.id = ${target.requestId}
    join units u
      on u.workspace_id = p.workspace_id
      and u.project_id = p.id
      and u.packet_id = r.id
      and u.id = ${target.unitId}
    join unit_versions v
      on v.workspace_id = u.workspace_id
      and v.project_id = u.project_id
      and v.unit_id = u.id
      and v.version = u.current_version
    join grants decide_grant
      on decide_grant.workspace_id = p.workspace_id
      and decide_grant.project_id = p.id
      and decide_grant.actor_id = p.approver_id
      and decide_grant.action = 'decide'
      and decide_grant.active = true
    join grants inspect_grant
      on inspect_grant.workspace_id = p.workspace_id
      and inspect_grant.project_id = p.id
      and inspect_grant.actor_id = p.approver_id
      and inspect_grant.action = 'inspect'
      and inspect_grant.epoch = ${target.inspectGrantEpoch}
      and inspect_grant.active = true
    where p.workspace_id = ${target.workspaceId}
      and p.id = ${target.projectId}
      and p.approver_id = ${reviewPrincipal.actorId}`
    .execute(transaction)).rows[0];
  if (!row) throw new ReviewLoadError("ACCESS_DENIED");
  return row;
}

async function sourceAttribution(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
  snapshot: PublishedUnit,
): Promise<ReviewProjection["attribution"]> {
  const sourceRows = snapshot.sourceReferences.length === 0
    ? []
    : (await sql<{
      position: number;
      source_id: string;
      source_version: number;
      availability: "available" | "unavailable";
      provenance_origin: string | null;
      studio_sharing: string | null;
    }>`select reference.position::integer,
        source.id as source_id,source.version as source_version,
        source.availability,intake.provenance_origin,intake.studio_sharing
      from jsonb_array_elements(
        ${JSON.stringify(snapshot.sourceReferences)}::jsonb
      ) with ordinality as reference(value,position)
      join source_versions source
        on source.workspace_id = ${target.workspaceId}
        and source.project_id = ${target.projectId}
        and source.id = reference.value->>'id'
        and source.version = (reference.value->>'version')::integer
      left join source_intake_records intake
        on intake.workspace_id = source.workspace_id
        and intake.project_id = source.project_id
        and intake.source_id = source.id
        and intake.source_version = source.version
      order by reference.position`
      .execute(transaction)).rows;
  if (sourceRows.length !== snapshot.sourceReferences.length) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  const sources = sourceRows.map((row, index) => {
    const expected = snapshot.sourceReferences[index];
    if (
      !expected
      || row.source_id !== expected.id
      || row.source_version !== expected.version
      || row.availability !== expected.availability
    ) {
      throw new ReviewLoadError("STALE_RECORD");
    }
    return Object.freeze({
      label: `Published source ${index + 1}`,
      version: row.source_version,
      availability: row.availability,
      origin: row.studio_sharing === "permitted"
        ? sourceOrigin(row.provenance_origin)
        : null,
      coverage: row.availability === "available"
        ? "Available in the published review basis"
        : "Named in the published basis; source unavailable",
    });
  });

  const baselineRows = snapshot.baselineReferences.length === 0
    ? []
    : (await sql<{
      position: number;
      baseline_id: string;
      baseline_version: number;
    }>`select reference.position::integer,
        baseline.id as baseline_id,baseline.version as baseline_version
      from jsonb_array_elements(
        ${JSON.stringify(snapshot.baselineReferences)}::jsonb
      ) with ordinality as reference(value,position)
      join baseline_versions baseline
        on baseline.workspace_id = ${target.workspaceId}
        and baseline.project_id = ${target.projectId}
        and baseline.id = reference.value->>'id'
        and baseline.version = (reference.value->>'version')::integer
      order by reference.position`
      .execute(transaction)).rows;
  if (baselineRows.length !== snapshot.baselineReferences.length) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  const baselines = baselineRows.map((row, index) => {
    const expected = snapshot.baselineReferences[index];
    if (
      !expected
      || row.baseline_id !== expected.id
      || row.baseline_version !== expected.version
    ) {
      throw new ReviewLoadError("STALE_RECORD");
    }
    return Object.freeze({
      label: `Confirmed baseline ${index + 1}`,
      version: row.baseline_version,
      coverage: "Confirmed published baseline" as const,
    });
  });
  return Object.freeze({
    sources: Object.freeze(sources),
    baselines: Object.freeze(baselines),
  });
}

async function currentFacts(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
  row: TargetRow,
  snapshot: PublishedUnit,
): Promise<Pick<ReviewProjection["facts"], "decision" | "payment" | "holds" | "workStart">> {
  const decisionRow = (await sql<{
    decision: "approve" | "decline";
    recorded_at: Date;
  }>`select decision,recorded_at from decisions
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and unit_id = ${target.unitId}
      and version = ${row.current_version}`
    .execute(transaction)).rows[0];
  const decision = Object.freeze({
    status: decisionRow?.decision === "approve"
      ? "approved" as const
      : decisionRow?.decision === "decline"
        ? "declined" as const
        : "not-recorded" as const,
    version: row.current_version,
    recordedAt: decisionRow ? iso(decisionRow.recorded_at) : null,
  });

  let payment: ReviewProjection["facts"]["payment"];
  if (snapshot.treatment === "additional-waived") {
    payment = Object.freeze({
      status: "not-required",
      verifiedAt: null,
    });
  } else if (decision.status !== "approved") {
    payment = Object.freeze({
      status: "not-authorized",
      verifiedAt: null,
    });
  } else {
    const obligation = (await sql<{
      obligation_id: string;
    }>`select id as obligation_id from obligations
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and unit_id = ${target.unitId}
        and version = ${row.current_version}`
      .execute(transaction)).rows[0];
    if (!obligation) throw new ReviewLoadError("STALE_RECORD");
    const fact = (await sql<{
      verified_at: Date;
    }>`select fact.verified_at
      from attempts attempt
      join operations operation
        on operation.workspace_id = attempt.workspace_id
        and operation.project_id = attempt.project_id
        and operation.attempt_id = attempt.id
        and operation.kind = 'capture'
      join payment_facts fact
        on fact.workspace_id = operation.workspace_id
        and fact.project_id = operation.project_id
        and fact.operation_id = operation.id
      where attempt.workspace_id = ${target.workspaceId}
        and attempt.project_id = ${target.projectId}
        and attempt.obligation_id = ${obligation.obligation_id}
      order by fact.verified_at desc
      limit 1`
      .execute(transaction)).rows[0];
    if (fact) {
      payment = Object.freeze({
        status: "verified",
        verifiedAt: iso(fact.verified_at),
      });
    } else {
      const attempt = (await sql<{
        state: string;
      }>`select state from attempts
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and obligation_id = ${obligation.obligation_id}
        order by created_at desc
        limit 1`
        .execute(transaction)).rows[0];
      const status = !attempt
        ? "not-initiated"
        : attempt.state === "unknown"
          ? "outcome-unknown"
          : attempt.state === "pending"
            ? "processing"
            : attempt.state === "completed"
              ? null
              : "in-progress";
      if (!status) throw new ReviewLoadError("STALE_RECORD");
      payment = Object.freeze({
        status,
        verifiedAt: null,
      });
    }
  }

  const holds = (await sql<{
    reason: string;
  }>`select reason from holds
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and unit_id = ${target.unitId}
      and resolved_at is null
    order by created_at,id collate "C"`
    .execute(transaction)).rows.map((hold) => Object.freeze({
    reason: hold.reason,
  }));
  const workStartRow = (await sql<{
    version: number;
    recorded_at: Date;
  }>`select (detail->>'version')::integer as version,recorded_at
    from protocol_history
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and event = 'work-started'
      and resource_id = ${target.unitId}
    order by sequence
    limit 1`
    .execute(transaction)).rows[0];
  return {
    decision,
    payment,
    holds: Object.freeze(holds),
    workStart: Object.freeze({
      recorded: Boolean(workStartRow),
      version: workStartRow?.version ?? null,
      recordedAt: workStartRow ? iso(workStartRow.recorded_at) : null,
    }),
  };
}

async function paymentAction(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
  row: TargetRow,
  codec: ReviewLocatorCodec,
  locators: ReviewLocators,
): Promise<ReviewProjection["actions"]["payment"]> {
  const payerId = "cedar-payer";
  const authority = (await sql<{
    obligation_id: string;
  }>`select obligation.id as obligation_id
    from obligations obligation
    join grants pay_grant
      on pay_grant.workspace_id = obligation.workspace_id
      and pay_grant.project_id = obligation.project_id
      and pay_grant.actor_id = ${payerId}
      and pay_grant.action = 'pay'
      and pay_grant.active = true
    join payer_nominations nomination
      on nomination.workspace_id = obligation.workspace_id
      and nomination.project_id = obligation.project_id
      and nomination.obligation_id = obligation.id
      and nomination.actor_id = ${payerId}
      and nomination.active = true
      and nomination.continuity_epoch = ${row.nomination_epoch}
    where obligation.workspace_id = ${target.workspaceId}
      and obligation.project_id = ${target.projectId}
      and obligation.unit_id = ${target.unitId}
      and obligation.version = ${row.current_version}
      and obligation.collectible = true
    limit 2`
    .execute(transaction)).rows;
  if (authority.length !== 1) {
    return Object.freeze({ available: false, url: null });
  }
  const payerLocator = codec.payer(
    target.workspaceId,
    target.projectId,
    target.requestId,
    target.unitId,
    row.current_version,
    row.digest,
    authority[0]!.obligation_id,
    payerId,
  );
  return Object.freeze({
    available: true,
    url: [
      "/pay",
      locators.projectLocator,
      locators.requestLocator,
      locators.unitLocator,
      payerLocator,
    ].join("/"),
  });
}

async function resolvableConcerns(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
  snapshot: PublishedUnit,
): Promise<readonly Readonly<{
  concernId: string;
  responseRevision: number;
}>[]> {
  if (snapshot.reconciliation.length === 0) return Object.freeze([]);
  const concernIds = snapshot.reconciliation.map((entry) => entry.concernId);
  const rows = (await sql<{
    concern_id: string;
    revision: number;
  }>`select hold.concern_id,response.revision
    from holds hold
    join correction_responses response
      on response.workspace_id = hold.workspace_id
      and response.project_id = hold.project_id
      and response.concern_id = hold.concern_id
    where hold.workspace_id = ${target.workspaceId}
      and hold.project_id = ${target.projectId}
      and hold.unit_id = ${target.unitId}
      and hold.reason = 'correction'
      and hold.resolved_at is null
      and hold.concern_id = any(${concernIds}::text[])
      and response.disposition <> 'request-information'
      and not exists (
        select 1 from correction_responses newer
        where newer.workspace_id = response.workspace_id
          and newer.project_id = response.project_id
          and newer.concern_id = response.concern_id
          and newer.revision > response.revision
      )
    order by hold.concern_id collate "C"`
    .execute(transaction)).rows;
  const eligible = rows.flatMap((row) => {
    const publishedResponse = snapshot.reconciliation.find(
      (entry) => entry.concernId === row.concern_id
        && entry.responseRevision === row.revision,
    );
    return publishedResponse
      ? [Object.freeze({
        concernId: publishedResponse.concernId,
        responseRevision: publishedResponse.responseRevision,
      })]
      : [];
  });
  return Object.freeze(eligible);
}

async function versionHistory(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
  currentVersion: number,
): Promise<ReviewProjection["history"]> {
  const count = (await sql<{
    count: string;
  }>`select count(*)::text as count from unit_versions
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and unit_id = ${target.unitId}`
    .execute(transaction)).rows[0];
  const total = Number(count?.count ?? "0");
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  const rows = (await sql<{
    version: number;
    published_at: Date;
    decision: "approve" | "decline" | null;
    decision_recorded_at: Date | null;
    currency: string | null;
    gross: string | null;
    collectible: boolean | null;
    payment_attempted: boolean;
    payment_verified_at: Date | null;
  }>`select unit_versions.version,unit_versions.published_at,
      d.decision,d.recorded_at as decision_recorded_at,
      o.currency,o.gross,o.collectible,
      coalesce(payment.payment_attempted,false) as payment_attempted,
      payment.payment_verified_at
    from unit_versions
    left join decisions d
      on d.workspace_id = unit_versions.workspace_id
      and d.project_id = unit_versions.project_id
      and d.unit_id = unit_versions.unit_id
      and d.version = unit_versions.version
    left join obligations o
      on o.workspace_id = unit_versions.workspace_id
      and o.project_id = unit_versions.project_id
      and o.unit_id = unit_versions.unit_id
      and o.version = unit_versions.version
    left join lateral (
      select
        exists (
          select 1 from attempts a
          where a.workspace_id = o.workspace_id
            and a.project_id = o.project_id
            and a.obligation_id = o.id
        ) as payment_attempted,
        (
          select max(f.verified_at)
          from attempts a
          join operations operation
            on operation.workspace_id = a.workspace_id
            and operation.project_id = a.project_id
            and operation.attempt_id = a.id
            and operation.kind = 'capture'
          join payment_facts f
            on f.workspace_id = operation.workspace_id
            and f.project_id = operation.project_id
            and f.operation_id = operation.id
          where a.workspace_id = o.workspace_id
            and a.project_id = o.project_id
            and a.obligation_id = o.id
        ) as payment_verified_at
    ) payment on o.id is not null
    where unit_versions.workspace_id = ${target.workspaceId}
      and unit_versions.project_id = ${target.projectId}
      and unit_versions.unit_id = ${target.unitId}
      and unit_versions.version <> ${currentVersion}
    order by unit_versions.version desc
    limit ${MAX_VISIBLE_HISTORY}`
    .execute(transaction)).rows;
  for (const row of rows) {
    if (row.currency !== null && row.currency !== "USD") {
      throw new ReviewLoadError("STALE_RECORD");
    }
  }
  const previousVersionCount = total - 1;
  return Object.freeze({
    previousVersionCount,
    previousVersions: Object.freeze(rows.map((version) => Object.freeze({
      version: version.version,
      publishedAt: iso(version.published_at),
      decision: Object.freeze({
        status: version.decision === "approve"
          ? "approved" as const
          : version.decision === "decline"
            ? "declined" as const
            : "not-recorded" as const,
        recordedAt: version.decision_recorded_at
          ? iso(version.decision_recorded_at)
          : null,
      }),
      obligation: version.currency === null
        || version.gross === null
        || version.collectible === null
        ? null
        : Object.freeze({
          currency: "USD" as const,
          gross: version.gross,
          collectionStatus: version.collectible
            ? "active" as const
            : "retired" as const,
          paymentStatus: version.payment_verified_at
            ? "verified" as const
            : version.payment_attempted
              ? "attempted" as const
              : "not-initiated" as const,
          verifiedAt: version.payment_verified_at
            ? iso(version.payment_verified_at)
            : null,
        }),
    }))),
    additionalPreviousVersions: Math.max(
      0,
      previousVersionCount - rows.length,
    ),
  });
}

function visibleList(values: readonly string[]): readonly string[] {
  return values.length > 0 ? Object.freeze([...values]) : Object.freeze([
    "None recorded.",
  ]);
}

function commercialComparison(snapshot: PublishedUnit): readonly string[] {
  if (snapshot.treatment === "additional-waived") {
    return Object.freeze([
      "Treatment: additional work with payment waived",
      `Payment: not required · ${snapshot.payment.explanation}`,
    ]);
  }
  return Object.freeze([
    "Treatment: additional payable work",
    ...snapshot.payment.financial.lines.map((line) =>
      `${line.description} · quantity ${line.quantity} · USD ${line.unitPrice} each · USD ${line.amount}`),
    `Subtotal: USD ${snapshot.payment.financial.subtotal}`,
    `Tax: ${snapshot.payment.financial.tax.treatment} · USD ${snapshot.payment.financial.tax.amount} · ${snapshot.payment.financial.tax.declaration}`,
    `Total: USD ${snapshot.payment.financial.gross}`,
    "Payment policy: full prepayment after fresh approval",
  ]);
}

function comparisonFields(snapshot: PublishedUnit): readonly Readonly<{
  field: string;
  values: readonly string[];
}>[] {
  return Object.freeze([
    { field: "Title", values: [snapshot.title] },
    { field: "Included scope", values: visibleList(snapshot.scope) },
    { field: "Exclusions", values: visibleList(snapshot.exclusions) },
    { field: "Provider rationale", values: [snapshot.rationale] },
    { field: "Delivery timing", values: [snapshot.timing.description] },
    {
      field: "Delivery dependencies",
      values: visibleList(snapshot.timing.deliveryDependencies),
    },
    {
      field: "Unit dependencies",
      values: visibleList(snapshot.dependencies.map((entry) =>
        entry.explanation)),
    },
    {
      field: "Prerequisites",
      values: visibleList(snapshot.prerequisites.map((entry) =>
        `${entry.description} · blocks ${entry.blocks.replaceAll("-", " ")}`)),
    },
    {
      field: "Source basis",
      values: snapshot.sourceReferences.map((source, index) =>
        `Published source ${index + 1} · version ${source.version} · ${source.availability} · ${source.locator}`),
    },
    {
      field: "Confirmed baselines",
      values: snapshot.baselineReferences.map((baseline, index) =>
        `Confirmed baseline ${index + 1} · version ${baseline.version}`),
    },
    { field: "Approval condition", values: [snapshot.approver.condition] },
    { field: "Commercial terms", values: commercialComparison(snapshot) },
  ]);
}

function exactDifferences(
  before: PublishedUnit,
  current: PublishedUnit,
): NonNullable<ReviewProjection["reissue"]>["differences"] {
  const beforeFields = comparisonFields(before);
  const currentFields = comparisonFields(current);
  return Object.freeze(currentFields.flatMap((field, index) => {
    const prior = beforeFields[index];
    if (
      !prior
      || prior.field !== field.field
      || JSON.stringify(prior.values) !== JSON.stringify(field.values)
    ) {
      return [Object.freeze({
        field: field.field,
        before: Object.freeze([...(prior?.values ?? ["Not recorded."])]),
        current: Object.freeze([...field.values]),
      })];
    }
    return [];
  }));
}

function correctionClaim(value: unknown): Readonly<{
  statement: string;
  claimedSourceType: string;
  sourceAvailability: "available" | "unavailable";
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  const claim = value as Record<string, unknown>;
  const source = claim.source;
  if (
    typeof claim.statement !== "string"
    || typeof claim.claimedSourceType !== "string"
    || !source
    || typeof source !== "object"
    || Array.isArray(source)
  ) {
    throw new ReviewLoadError("STALE_RECORD");
  }
  const availability = (source as Record<string, unknown>).availability;
  if (availability !== "available" && availability !== "unavailable") {
    throw new ReviewLoadError("STALE_RECORD");
  }
  return Object.freeze({
    statement: claim.statement,
    claimedSourceType: claim.claimedSourceType,
    sourceAvailability: availability,
  });
}

async function reissueProjection(
  transaction: ProtocolTransaction,
  target: ResolvedTarget,
  snapshot: PublishedUnit,
): Promise<ReviewProjection["reissue"]> {
  if (snapshot.reconciliation.length === 0) return null;
  const previousVersion = snapshot.version - 1;
  if (previousVersion < 1) throw new ReviewLoadError("STALE_RECORD");
  const previousRow = (await sql<{
    snapshot: unknown;
    canonical_bytes: Buffer;
    digest: string;
  }>`select snapshot,canonical_bytes,digest from unit_versions
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and unit_id = ${target.unitId}
      and version = ${previousVersion}`
    .execute(transaction)).rows[0];
  if (!previousRow) throw new ReviewLoadError("STALE_RECORD");
  let previousFrozen;
  try {
    previousFrozen = freezePublishedUnit(previousRow.snapshot);
  } catch {
    throw new ReviewLoadError("MALFORMED_RECORD");
  }
  if (
    previousFrozen.digest !== previousRow.digest
    || !previousFrozen.bytes.equals(previousRow.canonical_bytes)
    || previousFrozen.snapshot.unitId !== target.unitId
    || previousFrozen.snapshot.version !== previousVersion
  ) {
    throw new ReviewLoadError("STALE_RECORD");
  }

  const concernIds = snapshot.reconciliation.map((entry) => entry.concernId);
  const rows = (await sql<{
    concern_id: string;
    response_revision: number;
    provider_response: string;
    source_review: string;
    assessed_at: Date;
    claim: unknown;
  }>`select distinct on (a.concern_id)
      a.concern_id,a.response_revision,a.provider_response,a.source_review,
      a.assessed_at,c.claim
    from provider_reconciliation_assessments a
    join corrections c
      on c.workspace_id = a.workspace_id
      and c.project_id = a.project_id
      and c.id = a.concern_id
    where a.workspace_id = ${target.workspaceId}
      and a.project_id = ${target.projectId}
      and a.request_id = ${target.requestId}
      and a.unit_id = ${target.unitId}
      and a.unit_version = ${previousVersion}
      and a.applicability = 'material-change'
      and a.concern_id = any(${concernIds}::text[])
    order by a.concern_id,a.assessment_revision desc`
    .execute(transaction)).rows;
  if (rows.length === 0) return null;
  const contexts = snapshot.reconciliation.map((entry) => {
    const row = rows.find((candidate) =>
      candidate.concern_id === entry.concernId
      && candidate.response_revision === entry.responseRevision);
    if (!row) throw new ReviewLoadError("STALE_RECORD");
    return Object.freeze({
      ...correctionClaim(row.claim),
      providerResponse: row.provider_response,
      sourceReview: row.source_review,
      responseRevision: row.response_revision,
      assessedAt: iso(row.assessed_at),
    });
  });
  return Object.freeze({
    previousVersion,
    correctionContexts: Object.freeze(contexts),
    differences: exactDifferences(previousFrozen.snapshot, snapshot),
  });
}

function commercialTerms(
  snapshot: PublishedUnit,
): ReviewProjection["commercial"] {
  if (snapshot.treatment === "additional-waived") {
    return Object.freeze({
      kind: snapshot.treatment,
      policy: snapshot.payment.policy,
      explanation: snapshot.payment.explanation,
    });
  }
  return Object.freeze({
    kind: snapshot.treatment,
    policy: snapshot.payment.policy,
    currency: snapshot.payment.financial.currency,
    lines: Object.freeze(snapshot.payment.financial.lines.map((line) =>
      Object.freeze({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
      }))),
    subtotal: snapshot.payment.financial.subtotal,
    tax: Object.freeze({
      treatment: snapshot.payment.financial.tax.treatment,
      amount: snapshot.payment.financial.tax.amount,
      declaration: snapshot.payment.financial.tax.declaration,
    }),
    gross: snapshot.payment.financial.gross,
  });
}

export async function loadDatabaseReview(
  input: Readonly<{
    database: ProtocolDatabase;
    codec: ReviewLocatorCodec;
    expectedSubject: string;
    locators: ReviewLocators;
    session: ReviewSession;
  }>,
): Promise<ReviewProjection> {
  if (!safeEqual(input.session.subject, input.expectedSubject)) {
    throw new ReviewLoadError("ACCESS_DENIED");
  }
  const loaded = await input.database.transaction(async (transaction) => {
    const target = await resolveTarget(
      transaction,
      input.codec,
      input.locators,
    );
    const row = await loadTargetRow(transaction, target);
    const snapshot = verifiedSnapshot(row);
    const attribution = await sourceAttribution(
      transaction,
      target,
      snapshot,
    );
    const facts = await currentFacts(
      transaction,
      target,
      row,
      snapshot,
    );
    const resolutionConcerns = await resolvableConcerns(
      transaction,
      target,
      snapshot,
    );
    const reissue = await reissueProjection(
      transaction,
      target,
      snapshot,
    );
    const history = await versionHistory(
      transaction,
      target,
      row.current_version,
    );
    const payerAction = await paymentAction(
      transaction,
      target,
      row,
      input.codec,
      input.locators,
    );
    return {
      target,
      row,
      snapshot,
      attribution,
      facts,
      resolutionConcerns,
      reissue,
      history,
      payerAction,
    };
  });

  let inspection;
  try {
    inspection = await new OrderedConsentStore(input.database).inspectUnit({
      workspaceId: loaded.target.workspaceId,
      projectId: loaded.target.projectId,
      actorId: reviewPrincipal.actorId,
      grantEpoch: loaded.target.inspectGrantEpoch,
    }, loaded.target.unitId);
  } catch {
    throw new ReviewLoadError("STALE_RECORD");
  }
  if (
    inspection.currentVersion !== loaded.row.current_version
    || inspection.acceptedVersion !== loaded.row.accepted_version
  ) {
    throw new ReviewLoadError("STALE_RECORD");
  }

  return Object.freeze({
    project: Object.freeze({
      label: loaded.row.project_name
        ?? opaqueFallback("Project", input.locators.projectLocator),
    }),
    request: Object.freeze({
      label: loaded.row.request_title
        ?? opaqueFallback("Request", input.locators.requestLocator),
    }),
    unit: Object.freeze({
      title: loaded.snapshot.title,
      version: loaded.snapshot.version,
      publishedAt: iso(loaded.row.published_at),
      treatment: loaded.snapshot.treatment,
      approverCondition: loaded.snapshot.approver.condition,
      scope: Object.freeze([...loaded.snapshot.scope]),
      exclusions: Object.freeze([...loaded.snapshot.exclusions]),
      rationale: loaded.snapshot.rationale,
      timing: Object.freeze({
        description: loaded.snapshot.timing.description,
        deliveryDependencies: Object.freeze([
          ...loaded.snapshot.timing.deliveryDependencies,
        ]),
      }),
      dependencies: Object.freeze(loaded.snapshot.dependencies.map(
        (dependency) => Object.freeze({
          explanation: dependency.explanation,
        }),
      )),
      prerequisites: Object.freeze(loaded.snapshot.prerequisites.map(
        (prerequisite) => Object.freeze({
          description: prerequisite.description,
          blocks: prerequisite.blocks,
        }),
      )),
    }),
    commercial: commercialTerms(loaded.snapshot),
    attribution: loaded.attribution,
    reissue: loaded.reissue,
    facts: Object.freeze({
      ...loaded.facts,
      readiness: inspection.readiness,
      acceptedVersion: inspection.acceptedVersion,
    }),
    history: loaded.history,
    actions: Object.freeze({
      endpoint: [
        "/api/review",
        input.locators.projectLocator,
        input.locators.requestLocator,
        input.codec.mutationUnit(
          loaded.target.workspaceId,
          loaded.target.projectId,
          loaded.target.requestId,
          loaded.target.unitId,
          loaded.row.current_version,
          loaded.row.digest,
        ),
      ].join("/"),
      decision: Object.freeze({
        available: loaded.facts.decision.status === "not-recorded",
        responseAcknowledgementCount:
          loaded.resolutionConcerns.length,
      }),
      question: Object.freeze({ available: true as const }),
      correction: Object.freeze({ available: true as const }),
      payment: loaded.payerAction,
    }),
  });
}

export async function loadDatabaseReviewMutationBasis(
  input: Readonly<{
    database: ProtocolDatabase;
    codec: ReviewLocatorCodec;
    expectedSubject: string;
    locators: ReviewLocators;
    session: ReviewMutationSession;
  }>,
): Promise<ReviewMutationBasis> {
  if (!safeEqual(input.session.subject, input.expectedSubject)) {
    throw new ReviewLoadError("ACCESS_DENIED");
  }
  return input.database.transaction(async (transaction) => {
    const target = await resolveMutationTarget(
      transaction,
      input.codec,
      input.locators,
    );
    const row = await loadTargetRow(transaction, target);
    const snapshot = verifiedSnapshot(row);
    if (
      row.current_version !== target.matchedVersion
      || row.digest !== target.matchedDigest
      || !input.codec.matchesMutationUnit(
        input.locators.unitLocator,
        target.workspaceId,
        target.projectId,
        target.requestId,
        target.unitId,
        row.current_version,
        row.digest,
      )
    ) {
      throw new ReviewLoadError("STALE_RECORD");
    }
    const decision = (await sql<{
      decision: "approve" | "decline";
    }>`select decision from decisions
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and unit_id = ${target.unitId}
        and version = ${row.current_version}`
      .execute(transaction)).rows[0];
    return Object.freeze({
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      requestId: target.requestId,
      unitId: target.unitId,
      version: row.current_version,
      digest: row.digest,
      actorId: reviewPrincipal.actorId,
      nominationEpoch: row.nomination_epoch,
      decideGrantEpoch: target.decideGrantEpoch,
      correctGrantEpoch: target.correctGrantEpoch,
      terminalDecision: decision?.decision ?? null,
      resolutionConcerns: await resolvableConcerns(
        transaction,
        target,
        snapshot,
      ),
    });
  });
}


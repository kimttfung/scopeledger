import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  freezePublishedUnit,
} from "@scopeledger/contracts";
import {
  sql,
  type ProtocolDatabase,
  type ProtocolTransaction,
} from "@scopeledger/db";
import type {
  ParticipantOperation,
  ParticipantPreview,
  ParticipantStatus,
  ProviderParticipant,
} from "./service.js";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;
const fixedApproverId = "cedar-approver";
const fixedPayerId = "cedar-payer";
const maximumCandidates = 256;
const approverActions = ["inspect", "decide", "correct"] as const;

type ApproverAction = typeof approverActions[number];

type GrantState = Readonly<{
  action: ApproverAction;
  epoch: number;
  active: boolean;
}>;

type ApproverCandidate = Readonly<{
  kind: "project-approver";
  selector: string;
  projectId: string;
  projectLabel: string;
  currentActorId: string;
  nominationEpoch: number;
  currentGrants: readonly GrantState[];
  fixedGrants: readonly GrantState[];
}>;

type PayerCandidate = Readonly<{
  kind: "obligation-payer";
  selector: string;
  projectId: string;
  projectLabel: string;
  projectNominationEpoch: number;
  requestLabel: string;
  unitId: string;
  unitTitle: string;
  version: number;
  digest: string;
  obligationId: string;
  currency: "USD";
  gross: string;
  nomination: Readonly<{
    actorId: string;
    epoch: number;
    continuityEpoch: number;
    active: boolean;
  }> | null;
  grant: Readonly<{
    epoch: number;
    active: boolean;
  }> | null;
  hasAttempt: boolean;
  admittedCaptureRecovery: boolean;
}>;

type Candidate = ApproverCandidate | PayerCandidate;

type ProjectRow = Readonly<{
  project_id: string;
  project_label: string | null;
  approver_id: string;
  nomination_epoch: number;
}>;

type PayerRow = Readonly<{
  project_id: string;
  project_label: string | null;
  project_nomination_epoch: number;
  request_id: string;
  request_label: string | null;
  unit_id: string;
  version: number;
  snapshot: unknown;
  canonical_bytes: Buffer;
  digest: string;
  obligation_id: string;
  currency: "USD";
  gross: string;
  payer_actor_id: string | null;
  payer_epoch: number | null;
  continuity_epoch: number | null;
  payer_active: boolean | null;
  payer_grant_epoch: number | null;
  payer_grant_active: boolean | null;
  has_attempt: boolean;
  admitted_capture_recovery: boolean;
}>;

type ReceiptResult = Readonly<{
  schemaVersion: "scopeledger.participant-lifecycle.v1";
  confirmationLocator: string;
  selector: string;
  operation: ParticipantOperation;
  afterFingerprint: string;
}>;

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function derivedUuid(key: Buffer, namespace: string, value: string): string {
  const bytes = createHmac("sha256", key)
    .update(`${namespace}\u0000${value}`, "utf8")
    .digest()
    .subarray(0, 16);
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

export class ParticipantLifecycleLocatorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    if (!/^[a-f0-9]{64}$/iu.test(secret)) {
      throw new Error(
        "Participant lifecycle locator secret must be a 32-byte hexadecimal value",
      );
    }
    this.secret = Buffer.from(secret, "hex");
  }

  selector(
    kind: Candidate["kind"],
    projectId: string,
    obligationId: string | null = null,
  ): string {
    return `slpt1_${createHmac("sha256", this.secret)
      .update([
        "scopeledger.provider-participant-selector.v1",
        workspaceId,
        kind,
        projectId,
        obligationId ?? "",
      ].join("\u0000"), "utf8")
      .digest("base64url")}`;
  }

  confirmation(
    candidate: Candidate,
    operation: ParticipantOperation,
  ): string {
    return `slpcf1_${candidate.selector.slice("slpt1_".length)}_${
      createHmac("sha256", this.secret)
        .update([
          "scopeledger.provider-participant-confirmation.v1",
          operation,
          candidate.selector,
          stateFingerprint(candidate),
        ].join("\u0000"), "utf8")
        .digest("base64url")
    }`;
  }

  commandId(confirmationLocator: string): string {
    return derivedUuid(
      this.secret,
      "scopeledger.provider-participant-command.v1",
      confirmationLocator,
    );
  }
}

function projectLabel(row: ProjectRow, selector: string): string {
  return row.project_label
    ?? `Provider project · ${selector.slice(-8).toUpperCase()}`;
}

function safeRequestLabel(
  label: string | null,
  selector: string,
): string {
  return label ?? `Approved request · ${selector.slice(-8).toUpperCase()}`;
}

function sortedGrants(grants: readonly GrantState[]): readonly GrantState[] {
  return Object.freeze([...grants].sort((left, right) =>
    left.action.localeCompare(right.action, "en")));
}

function exactActiveApproverGrants(grants: readonly GrantState[]): boolean {
  return grants.length === approverActions.length
    && approverActions.every((action) =>
      grants.some((grant) => grant.action === action && grant.active));
}

function exactInactiveApproverGrants(grants: readonly GrantState[]): boolean {
  return grants.length === approverActions.length
    && grants.every((grant) => !grant.active);
}

function approverStatus(candidate: ApproverCandidate): ParticipantStatus {
  if (exactActiveApproverGrants(candidate.currentGrants)) {
    return candidate.currentActorId === fixedApproverId
      ? "active"
      : "replacement-active";
  }
  if (
    candidate.currentGrants.length === 0
    || exactInactiveApproverGrants(candidate.currentGrants)
  ) {
    return "revoked";
  }
  return "incomplete";
}

function payerStatus(candidate: PayerCandidate): ParticipantStatus {
  if (!candidate.nomination) return "not-assigned";
  if (
    candidate.nomination.active
    && candidate.grant?.active
    && candidate.nomination.continuityEpoch
      === candidate.projectNominationEpoch
  ) {
    return candidate.nomination.actorId === fixedPayerId
      ? "active"
      : "replacement-active";
  }
  if (
    candidate.nomination.active
    && candidate.nomination.continuityEpoch
      !== candidate.projectNominationEpoch
  ) {
    return "continuity-changed";
  }
  if (!candidate.nomination.active || candidate.grant?.active === false) {
    return "revoked";
  }
  return "incomplete";
}

function availableOperations(
  candidate: Candidate,
): readonly ParticipantOperation[] {
  if (candidate.kind === "project-approver") {
    const active = exactActiveApproverGrants(candidate.currentGrants);
    return Object.freeze([
      ...(active ? ["revoke-approver" as const] : []),
      ...(
        candidate.currentActorId !== fixedApproverId || !active
          ? ["restore-approver" as const]
          : []
      ),
    ]);
  }
  const revocable = candidate.nomination?.active === true
    && candidate.grant?.active === true;
  return Object.freeze([
    ...(revocable ? ["revoke-payer" as const] : []),
    ...(
      candidate.nomination
      && !candidate.hasAttempt
      && (
        candidate.nomination.actorId !== fixedPayerId
        || payerStatus(candidate) !== "active"
      )
        ? ["restore-payer" as const]
        : []
    ),
  ]);
}

function publicParticipant(candidate: Candidate): ProviderParticipant {
  if (candidate.kind === "project-approver") {
    return Object.freeze({
      selector: candidate.selector,
      kind: candidate.kind,
      projectLabel: candidate.projectLabel,
      requestLabel: null,
      unitTitle: null,
      amount: null,
      participantLabel: candidate.currentActorId === fixedApproverId
        ? "Fixed local demo approver"
        : "Current project approver",
      status: approverStatus(candidate),
      recovery: "none",
      availableOperations: availableOperations(candidate),
    });
  }
  return Object.freeze({
    selector: candidate.selector,
    kind: candidate.kind,
    projectLabel: candidate.projectLabel,
    requestLabel: candidate.requestLabel,
    unitTitle: candidate.unitTitle,
    amount: Object.freeze({
      currency: candidate.currency,
      gross: candidate.gross,
    }),
    participantLabel: candidate.nomination?.actorId === fixedPayerId
      ? "Fixed local demo payer"
      : candidate.nomination
        ? "Current obligation payer"
        : "No payer assigned",
    status: payerStatus(candidate),
    recovery: candidate.admittedCaptureRecovery
      ? "admitted-capture"
      : "none",
    availableOperations: availableOperations(candidate),
  });
}

function stateFingerprint(candidate: Candidate): string {
  if (candidate.kind === "project-approver") {
    return digest({
      kind: candidate.kind,
      projectId: candidate.projectId,
      currentActorId: candidate.currentActorId,
      nominationEpoch: candidate.nominationEpoch,
      currentGrants: candidate.currentGrants,
      fixedGrants: candidate.fixedGrants,
    });
  }
  return digest({
    kind: candidate.kind,
    projectId: candidate.projectId,
    projectNominationEpoch: candidate.projectNominationEpoch,
    unitId: candidate.unitId,
    version: candidate.version,
    digest: candidate.digest,
    obligationId: candidate.obligationId,
    nomination: candidate.nomination,
    grant: candidate.grant,
    hasAttempt: candidate.hasAttempt,
    admittedCaptureRecovery: candidate.admittedCaptureRecovery,
  });
}

function authorityFingerprint(candidate: Candidate): string {
  if (candidate.kind === "project-approver") {
    return stateFingerprint(candidate);
  }
  return digest({
    kind: candidate.kind,
    projectId: candidate.projectId,
    projectNominationEpoch: candidate.projectNominationEpoch,
    unitId: candidate.unitId,
    version: candidate.version,
    digest: candidate.digest,
    obligationId: candidate.obligationId,
    nomination: candidate.nomination,
    grant: candidate.grant,
  });
}

function previewFor(
  codec: ParticipantLifecycleLocatorCodec,
  candidate: Candidate,
  operation: ParticipantOperation,
): ParticipantPreview {
  if (!availableOperations(candidate).includes(operation)) {
    throw coded("STALE_CONTEXT");
  }
  const shared = {
    confirmationLocator: codec.confirmation(candidate, operation),
    operation,
    projectLabel: candidate.projectLabel,
    requestLabel: candidate.kind === "obligation-payer"
      ? candidate.requestLabel
      : null,
    unitTitle: candidate.kind === "obligation-payer"
      ? candidate.unitTitle
      : null,
    amount: candidate.kind === "obligation-payer"
      ? Object.freeze({
        currency: candidate.currency,
        gross: candidate.gross,
      })
      : null,
  };
  switch (operation) {
    case "revoke-approver":
      return Object.freeze({
        ...shared,
        participantLabel: publicParticipant(candidate).participantLabel,
        effect: Object.freeze([
          "Blocks future project inspection, decisions, and corrections for the current approver immediately.",
          "Leaves the project nomination in place until an explicit restore.",
        ]),
        preserved: Object.freeze([
          "Prior decisions and correction attribution remain unchanged.",
          "Published versions and every other project remain unchanged.",
          "No payer authority is granted or revoked by this action.",
        ]),
        requiresReissue: false,
        admittedCaptureRecoveryPreserved: false,
      });
    case "restore-approver":
      return Object.freeze({
        ...shared,
        participantLabel: "Fixed local demo approver",
        effect: Object.freeze([
          "Creates a new project approver nomination epoch.",
          "Activates fresh inspect, decide, and correct grants for the fixed local demo approver.",
          "Revokes the prior current approver's prospective project authority.",
        ]),
        preserved: Object.freeze([
          "Prior decisions, corrections, publications, and actor attribution remain unchanged.",
          "No payer nomination or payment permission is created.",
          "No authority is created for another project.",
        ]),
        requiresReissue: true,
        admittedCaptureRecoveryPreserved: false,
      });
    case "revoke-payer":
      return Object.freeze({
        ...shared,
        participantLabel: publicParticipant(candidate).participantLabel,
        effect: Object.freeze([
          "Blocks every future payment admission for the current obligation payer immediately.",
          "Retains the approved obligation without assigning approver authority.",
        ]),
        preserved: Object.freeze([
          "Prior decisions, payment attempts, captures, and attribution remain unchanged.",
          "Already-admitted capture recovery remains tied to its original operation.",
          "No payer or approver authority changes on another project.",
        ]),
        requiresReissue: false,
        admittedCaptureRecoveryPreserved:
          candidate.kind === "obligation-payer"
          && candidate.admittedCaptureRecovery,
      });
    case "restore-payer":
      return Object.freeze({
        ...shared,
        participantLabel: "Fixed local demo payer",
        effect: Object.freeze([
          "Creates a new obligation-scoped payer epoch for the fixed local demo payer.",
          "Binds payer continuity to the current project nomination epoch.",
          "Revokes the prior obligation payer's prospective payment authority.",
        ]),
        preserved: Object.freeze([
          "The approved amount, decision, and obligation remain unchanged.",
          "No inspect, decide, correct, publish, or nominate authority is created.",
          "No authority is created for another obligation or project.",
        ]),
        requiresReissue: false,
        admittedCaptureRecoveryPreserved: false,
      });
  }
}

async function bounded<T>(rows: Promise<readonly T[]>): Promise<readonly T[]> {
  const resolved = await rows;
  if (resolved.length > maximumCandidates) throw coded("STALE_RECORD");
  return resolved;
}

async function projectRows(
  transaction: ProtocolTransaction,
): Promise<readonly ProjectRow[]> {
  return bounded((async () => (await sql<ProjectRow>`select
      p.id as project_id,p.provider_display_name as project_label,
      p.approver_id,p.nomination_epoch
    from projects p
    join grants provider_inspect
      on provider_inspect.workspace_id = p.workspace_id
      and provider_inspect.project_id = p.id
      and provider_inspect.actor_id = ${providerActorId}
      and provider_inspect.action = 'inspect'
      and provider_inspect.epoch = ${providerGrantEpoch}
      and provider_inspect.active = true
    where p.workspace_id = ${workspaceId}
    order by p.provider_created_at desc nulls last,p.id collate "C"
    limit ${maximumCandidates + 1}`
    .execute(transaction)).rows)());
}

async function grantsFor(
  transaction: ProtocolTransaction,
  projectId: string,
  actorId: string,
): Promise<readonly GrantState[]> {
  const rows = (await sql<{
    action: ApproverAction;
    epoch: number;
    active: boolean;
  }>`select action,epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and actor_id = ${actorId}
      and action = any(${[...approverActions]}::text[])
    order by action collate "C"`
    .execute(transaction)).rows;
  return sortedGrants(rows);
}

async function approverCandidates(
  transaction: ProtocolTransaction,
  codec: ParticipantLifecycleLocatorCodec,
): Promise<readonly ApproverCandidate[]> {
  const candidates: ApproverCandidate[] = [];
  for (const row of await projectRows(transaction)) {
    const selector = codec.selector("project-approver", row.project_id);
    const currentGrants = await grantsFor(
      transaction,
      row.project_id,
      row.approver_id,
    );
    const fixedGrants = row.approver_id === fixedApproverId
      ? currentGrants
      : await grantsFor(transaction, row.project_id, fixedApproverId);
    candidates.push(Object.freeze({
      kind: "project-approver",
      selector,
      projectId: row.project_id,
      projectLabel: projectLabel(row, selector),
      currentActorId: row.approver_id,
      nominationEpoch: row.nomination_epoch,
      currentGrants,
      fixedGrants,
    }));
  }
  return Object.freeze(candidates);
}

async function payerRows(
  transaction: ProtocolTransaction,
): Promise<readonly PayerRow[]> {
  return bounded((async () => (await sql<PayerRow>`select
      p.id as project_id,p.provider_display_name as project_label,
      p.nomination_epoch as project_nomination_epoch,
      packet.id as request_id,packet.provider_title as request_label,
      unit.id as unit_id,unit.current_version as version,
      version.snapshot,version.canonical_bytes,version.digest,
      obligation.id as obligation_id,obligation.currency,obligation.gross,
      nomination.actor_id as payer_actor_id,
      nomination.epoch as payer_epoch,
      nomination.continuity_epoch,
      nomination.active as payer_active,
      payer_grant.epoch as payer_grant_epoch,
      payer_grant.active as payer_grant_active,
      exists (
        select 1 from attempts attempt
        where attempt.workspace_id = obligation.workspace_id
          and attempt.project_id = obligation.project_id
          and attempt.obligation_id = obligation.id
      ) as has_attempt,
      exists (
        select 1
        from attempts attempt
        join operations operation
          on operation.workspace_id = attempt.workspace_id
          and operation.project_id = attempt.project_id
          and operation.attempt_id = attempt.id
          and operation.kind = 'capture'
          and operation.admitted_at is not null
        where attempt.workspace_id = obligation.workspace_id
          and attempt.project_id = obligation.project_id
          and attempt.obligation_id = obligation.id
          and attempt.resolved_at is null
      ) as admitted_capture_recovery
    from projects p
    join grants provider_inspect
      on provider_inspect.workspace_id = p.workspace_id
      and provider_inspect.project_id = p.id
      and provider_inspect.actor_id = ${providerActorId}
      and provider_inspect.action = 'inspect'
      and provider_inspect.epoch = ${providerGrantEpoch}
      and provider_inspect.active = true
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
    left join payer_nominations nomination
      on nomination.workspace_id = obligation.workspace_id
      and nomination.project_id = obligation.project_id
      and nomination.obligation_id = obligation.id
    left join grants payer_grant
      on payer_grant.workspace_id = obligation.workspace_id
      and payer_grant.project_id = obligation.project_id
      and payer_grant.actor_id = nomination.actor_id
      and payer_grant.action = 'pay'
    where p.workspace_id = ${workspaceId}
    order by p.id collate "C",packet.id collate "C",unit.id collate "C"
    limit ${maximumCandidates + 1}`
    .execute(transaction)).rows)());
}

function verifiedPayerCandidate(
  codec: ParticipantLifecycleLocatorCodec,
  row: PayerRow,
): PayerCandidate {
  let frozen;
  try {
    frozen = freezePublishedUnit(row.snapshot);
  } catch {
    throw coded("STALE_RECORD");
  }
  if (
    frozen.digest !== row.digest
    || !frozen.bytes.equals(row.canonical_bytes)
    || frozen.snapshot.workspaceId !== workspaceId
    || frozen.snapshot.projectId !== row.project_id
    || frozen.snapshot.unitId !== row.unit_id
    || frozen.snapshot.version !== row.version
    || frozen.snapshot.treatment !== "payable"
    || frozen.snapshot.payment.financial.currency !== row.currency
    || frozen.snapshot.payment.financial.gross !== row.gross
  ) {
    throw coded("STALE_RECORD");
  }
  const selector = codec.selector(
    "obligation-payer",
    row.project_id,
    row.obligation_id,
  );
  return Object.freeze({
    kind: "obligation-payer",
    selector,
    projectId: row.project_id,
    projectLabel: row.project_label
      ?? `Provider project · ${selector.slice(-8).toUpperCase()}`,
    projectNominationEpoch: row.project_nomination_epoch,
    requestLabel: safeRequestLabel(row.request_label, selector),
    unitId: row.unit_id,
    unitTitle: frozen.snapshot.title,
    version: row.version,
    digest: row.digest,
    obligationId: row.obligation_id,
    currency: row.currency,
    gross: row.gross,
    nomination: row.payer_actor_id
      && row.payer_epoch !== null
      && row.continuity_epoch !== null
      && row.payer_active !== null
      ? Object.freeze({
        actorId: row.payer_actor_id,
        epoch: row.payer_epoch,
        continuityEpoch: row.continuity_epoch,
        active: row.payer_active,
      })
      : null,
    grant: row.payer_grant_epoch !== null
      && row.payer_grant_active !== null
      ? Object.freeze({
        epoch: row.payer_grant_epoch,
        active: row.payer_grant_active,
      })
      : null,
    hasAttempt: row.has_attempt,
    admittedCaptureRecovery: row.admitted_capture_recovery,
  });
}

async function payerCandidates(
  transaction: ProtocolTransaction,
  codec: ParticipantLifecycleLocatorCodec,
): Promise<readonly PayerCandidate[]> {
  return Object.freeze((await payerRows(transaction)).map((row) =>
    verifiedPayerCandidate(codec, row)));
}

async function candidates(
  transaction: ProtocolTransaction,
  codec: ParticipantLifecycleLocatorCodec,
): Promise<readonly Candidate[]> {
  const approvers = await approverCandidates(transaction, codec);
  const payers = await payerCandidates(transaction, codec);
  if (approvers.length + payers.length > maximumCandidates) {
    throw coded("STALE_RECORD");
  }
  return Object.freeze([...approvers, ...payers]);
}

async function candidateFor(
  transaction: ProtocolTransaction,
  codec: ParticipantLifecycleLocatorCodec,
  selector: string,
): Promise<Candidate> {
  const matches = (await candidates(transaction, codec)).filter((candidate) =>
    safeEqual(candidate.selector, selector));
  if (matches.length !== 1) {
    throw coded(matches.length === 0 ? "NOT_FOUND" : "STALE_RECORD");
  }
  return matches[0]!;
}

async function requireProviderPublish(
  transaction: ProtocolTransaction,
  projectId: string,
): Promise<void> {
  const grant = (await sql<{ epoch: number; active: boolean }>`select
      epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and actor_id = ${providerActorId}
      and action = 'publish'
    for update`
    .execute(transaction)).rows[0];
  if (!grant?.active || grant.epoch !== providerGrantEpoch) {
    throw coded("ACCESS_DENIED");
  }
}

async function history(
  transaction: ProtocolTransaction,
  candidate: Candidate,
  event: string,
  resourceId: string,
  detail: unknown,
): Promise<void> {
  await sql`insert into protocol_history(
      workspace_id,project_id,actor_id,event,resource_id,detail
    ) values (
      ${workspaceId},${candidate.projectId},${providerActorId},
      ${event},${resourceId},${JSON.stringify(detail)}::jsonb
    )`
    .execute(transaction);
}

async function revokeApprover(
  transaction: ProtocolTransaction,
  candidate: ApproverCandidate,
): Promise<void> {
  if (!exactActiveApproverGrants(candidate.currentGrants)) {
    throw coded("STALE_CONTEXT");
  }
  const changed = (await sql<{ action: string; epoch: number }>`update grants
    set active = false,epoch = epoch + 1
    where workspace_id = ${workspaceId}
      and project_id = ${candidate.projectId}
      and actor_id = ${candidate.currentActorId}
      and action = any(${[...approverActions]}::text[])
      and active = true
    returning action,epoch`
    .execute(transaction)).rows;
  if (changed.length !== approverActions.length) throw coded("STALE_CONTEXT");
  await history(
    transaction,
    candidate,
    "approver-authority-revoked",
    candidate.currentActorId,
    {
      nominationEpoch: candidate.nominationEpoch,
      grantEpochs: Object.fromEntries(
        changed.map((grant) => [grant.action, grant.epoch]),
      ),
      prospectiveOnly: true,
    },
  );
}

async function restoreApprover(
  transaction: ProtocolTransaction,
  candidate: ApproverCandidate,
): Promise<void> {
  if (
    candidate.currentActorId === fixedApproverId
    && exactActiveApproverGrants(candidate.currentGrants)
  ) {
    throw coded("STALE_CONTEXT");
  }
  const updated = (await sql<{ nomination_epoch: number }>`update projects
    set approver_id = ${fixedApproverId},
        nomination_epoch = nomination_epoch + 1
    where workspace_id = ${workspaceId}
      and id = ${candidate.projectId}
      and approver_id = ${candidate.currentActorId}
      and nomination_epoch = ${candidate.nominationEpoch}
    returning nomination_epoch`
    .execute(transaction)).rows[0];
  if (!updated) throw coded("STALE_CONTEXT");
  if (candidate.currentActorId !== fixedApproverId) {
    await sql`update grants
      set active = false,epoch = epoch + 1
      where workspace_id = ${workspaceId}
        and project_id = ${candidate.projectId}
        and actor_id = ${candidate.currentActorId}
        and action = any(${[...approverActions]}::text[])`
      .execute(transaction);
  }
  const grantEpochs: Record<ApproverAction, number> = {
    inspect: 0,
    decide: 0,
    correct: 0,
  };
  for (const action of approverActions) {
    const grant = (await sql<{ epoch: number }>`insert into grants(
        workspace_id,project_id,actor_id,action,active
      ) values (
        ${workspaceId},${candidate.projectId},${fixedApproverId},${action},true
      )
      on conflict (workspace_id,project_id,actor_id,action)
      do update set active = true,epoch = grants.epoch + 1
      returning epoch`
      .execute(transaction)).rows[0];
    if (!grant) throw coded("STALE_CONTEXT");
    grantEpochs[action] = grant.epoch;
  }
  await history(
    transaction,
    candidate,
    "approver-authority-restored",
    fixedApproverId,
    {
      previousActorId: candidate.currentActorId,
      previousNominationEpoch: candidate.nominationEpoch,
      nominationEpoch: updated.nomination_epoch,
      grantEpochs,
      unacceptedPublishedUnitsRequireReissue: true,
    },
  );
}

async function revokePayer(
  transaction: ProtocolTransaction,
  candidate: PayerCandidate,
): Promise<void> {
  if (
    !candidate.nomination?.active
    || !candidate.grant?.active
  ) {
    throw coded("STALE_CONTEXT");
  }
  const otherActive = (await sql`select 1 from payer_nominations
    where workspace_id = ${workspaceId}
      and project_id = ${candidate.projectId}
      and actor_id = ${candidate.nomination.actorId}
      and obligation_id <> ${candidate.obligationId}
      and active = true
    limit 1`
    .execute(transaction)).rows[0];
  if (otherActive) throw coded("STALE_CONTEXT");
  const nomination = (await sql<{ epoch: number }>`update payer_nominations
    set active = false,epoch = epoch + 1,
        nominated_by = ${providerActorId},
        basis = 'Provider explicitly revoked prospective payer authority.'
    where workspace_id = ${workspaceId}
      and project_id = ${candidate.projectId}
      and obligation_id = ${candidate.obligationId}
      and actor_id = ${candidate.nomination.actorId}
      and epoch = ${candidate.nomination.epoch}
      and active = true
    returning epoch`
    .execute(transaction)).rows[0];
  const grant = (await sql<{ epoch: number }>`update grants
    set active = false,epoch = epoch + 1
    where workspace_id = ${workspaceId}
      and project_id = ${candidate.projectId}
      and actor_id = ${candidate.nomination.actorId}
      and action = 'pay'
      and epoch = ${candidate.grant.epoch}
      and active = true
    returning epoch`
    .execute(transaction)).rows[0];
  if (!nomination || !grant) throw coded("STALE_CONTEXT");
  await history(
    transaction,
    candidate,
    "payer-authority-revoked",
    candidate.obligationId,
    {
      payerId: candidate.nomination.actorId,
      payerEpoch: nomination.epoch,
      grantEpoch: grant.epoch,
      admittedCaptureRecoveryPreserved:
        candidate.admittedCaptureRecovery,
      prospectiveOnly: true,
    },
  );
}

async function restorePayer(
  transaction: ProtocolTransaction,
  candidate: PayerCandidate,
): Promise<void> {
  if (!candidate.nomination || candidate.hasAttempt) {
    throw coded("STALE_CONTEXT");
  }
  if (
    candidate.nomination.actorId === fixedPayerId
    && payerStatus(candidate) === "active"
  ) {
    throw coded("STALE_CONTEXT");
  }
  if (candidate.nomination.actorId !== fixedPayerId) {
    const otherActive = (await sql`select 1 from payer_nominations
      where workspace_id = ${workspaceId}
        and project_id = ${candidate.projectId}
        and actor_id = ${candidate.nomination.actorId}
        and obligation_id <> ${candidate.obligationId}
        and active = true
      limit 1`
      .execute(transaction)).rows[0];
    if (!otherActive) {
      await sql`update grants
        set active = false,epoch = epoch + 1
        where workspace_id = ${workspaceId}
          and project_id = ${candidate.projectId}
          and actor_id = ${candidate.nomination.actorId}
          and action = 'pay'`
        .execute(transaction);
    }
  }
  const grant = (await sql<{ epoch: number }>`insert into grants(
      workspace_id,project_id,actor_id,action,active
    ) values (
      ${workspaceId},${candidate.projectId},${fixedPayerId},'pay',true
    )
    on conflict (workspace_id,project_id,actor_id,action)
    do update set active = true,epoch = grants.epoch + 1
    returning epoch`
    .execute(transaction)).rows[0];
  const nomination = (await sql<{ epoch: number }>`update payer_nominations
    set actor_id = ${fixedPayerId},
        epoch = epoch + 1,
        continuity_epoch = ${candidate.projectNominationEpoch},
        active = true,
        nominated_by = ${providerActorId},
        basis = 'Provider explicitly restored the fixed local demo payer under a new obligation epoch.'
    where workspace_id = ${workspaceId}
      and project_id = ${candidate.projectId}
      and obligation_id = ${candidate.obligationId}
      and actor_id = ${candidate.nomination.actorId}
      and epoch = ${candidate.nomination.epoch}
    returning epoch`
    .execute(transaction)).rows[0];
  if (!grant || !nomination) throw coded("STALE_CONTEXT");
  await history(
    transaction,
    candidate,
    "payer-authority-restored",
    candidate.obligationId,
    {
      previousPayerId: candidate.nomination.actorId,
      payerId: fixedPayerId,
      payerEpoch: nomination.epoch,
      grantEpoch: grant.epoch,
      continuityEpoch: candidate.projectNominationEpoch,
      obligationScoped: true,
    },
  );
}

function operationMatches(
  candidate: Candidate,
  operation: ParticipantOperation,
): boolean {
  return (candidate.kind === "project-approver"
    ? operation === "revoke-approver" || operation === "restore-approver"
    : operation === "revoke-payer" || operation === "restore-payer")
    && availableOperations(candidate).includes(operation);
}

async function applyOperation(
  transaction: ProtocolTransaction,
  candidate: Candidate,
  operation: ParticipantOperation,
): Promise<void> {
  if (!operationMatches(candidate, operation)) throw coded("STALE_CONTEXT");
  switch (operation) {
    case "revoke-approver":
      return revokeApprover(transaction, candidate as ApproverCandidate);
    case "restore-approver":
      return restoreApprover(transaction, candidate as ApproverCandidate);
    case "revoke-payer":
      return revokePayer(transaction, candidate as PayerCandidate);
    case "restore-payer":
      return restorePayer(transaction, candidate as PayerCandidate);
  }
}

export class ParticipantLifecycleStore {
  readonly codec: ParticipantLifecycleLocatorCodec;

  constructor(
    private readonly database: ProtocolDatabase,
    secret: string,
  ) {
    this.codec = new ParticipantLifecycleLocatorCodec(secret);
  }

  async list(): Promise<readonly ProviderParticipant[]> {
    return this.database.transaction(async (transaction) =>
      Object.freeze((await candidates(transaction, this.codec))
        .map(publicParticipant)));
  }

  async preview(
    selector: string,
    operation: ParticipantOperation,
  ): Promise<ParticipantPreview> {
    return this.database.transaction(async (transaction) => {
      const candidate = await candidateFor(transaction, this.codec, selector);
      await requireProviderPublish(transaction, candidate.projectId);
      return previewFor(this.codec, candidate, operation);
    });
  }

  async confirm(
    confirmationLocator: string,
  ): Promise<Readonly<{
    participant: ProviderParticipant;
    duplicate: boolean;
  }>> {
    const match =
      /^slpcf1_([A-Za-z0-9_-]{43})_([A-Za-z0-9_-]{43})$/u
        .exec(confirmationLocator);
    if (!match) throw coded("NOT_FOUND");
    const selector = `slpt1_${match[1]}`;
    return this.database.transaction(async (transaction) => {
      let candidate = await candidateFor(
        transaction,
        this.codec,
        selector,
      );
      await sql`select id from projects
        where workspace_id = ${workspaceId}
          and id = ${candidate.projectId}
        for update`
        .execute(transaction);
      await requireProviderPublish(transaction, candidate.projectId);
      const commandId = this.codec.commandId(confirmationLocator);
      await sql`select pg_advisory_xact_lock(hashtextextended(
          ${`${workspaceId}/${candidate.projectId}/${providerActorId}/${commandId}`},
          0
        ))`
        .execute(transaction);
      candidate = await candidateFor(transaction, this.codec, selector);
      const receipt = (await sql<{
        action: string;
        payload_hash: string;
        result: ReceiptResult;
      }>`select action,payload_hash,result from command_receipts
        where workspace_id = ${workspaceId}
          and project_id = ${candidate.projectId}
          and actor_id = ${providerActorId}
          and command_id = ${commandId}::uuid`
        .execute(transaction)).rows[0];
      if (receipt) {
        const expectedHash = digest({
          operation: receipt.result.operation,
          confirmationLocator,
        });
        if (
          receipt.action !== "publish"
          || receipt.payload_hash !== expectedHash
          || receipt.result.schemaVersion
            !== "scopeledger.participant-lifecycle.v1"
          || !safeEqual(
            receipt.result.confirmationLocator,
            confirmationLocator,
          )
          || !safeEqual(receipt.result.selector, selector)
        ) {
          throw coded("IDEMPOTENCY_CONFLICT");
        }
        if (
          receipt.result.afterFingerprint !== authorityFingerprint(candidate)
        ) {
          throw coded("STALE_CONTEXT");
        }
        return Object.freeze({
          participant: publicParticipant(candidate),
          duplicate: true,
        });
      }
      const operation = availableOperations(candidate).find((candidateOperation) =>
        safeEqual(
          this.codec.confirmation(candidate, candidateOperation),
          confirmationLocator,
        ));
      if (!operation) throw coded("STALE_CONTEXT");
      await applyOperation(transaction, candidate, operation);
      candidate = await candidateFor(transaction, this.codec, selector);
      const result: ReceiptResult = Object.freeze({
        schemaVersion: "scopeledger.participant-lifecycle.v1",
        confirmationLocator,
        selector,
        operation,
        afterFingerprint: authorityFingerprint(candidate),
      });
      await sql`insert into command_receipts(
          workspace_id,project_id,actor_id,command_id,
          action,payload_hash,result
        ) values (
          ${workspaceId},${candidate.projectId},${providerActorId},
          ${commandId}::uuid,'publish',
          ${digest({ operation, confirmationLocator })},
          ${JSON.stringify(result)}::jsonb
        )`
        .execute(transaction);
      return Object.freeze({
        participant: publicParticipant(candidate),
        duplicate: false,
      });
    });
  }
}

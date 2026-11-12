import { randomUUID } from "node:crypto";
import {
  actorSchema, canonicalJson, commandIdentifier, digestSchema, freezePublishedUnit, identifier,
  leaseSchema, observationSchema, parseInput, payerSchema, ProtocolError, publishedUnitSchema,
  revision, sha256, text, z,
} from "@scopeledger/contracts";
import type { Actor, Lease, Payer, PaymentObservation, PublishedUnit } from "@scopeledger/contracts";
import { sql } from "@scopeledger/db";
import type { ProtocolDatabase, ProtocolTransaction, SqlExecutor } from "@scopeledger/db";

type Action = "publish" | "decide" | "correct" | "nominate" | "review" | "pay" | "inspect";
type Scope = { workspaceId: string; projectId: string };
type Project = {
  client_id: string; approver_id: string; nomination_epoch: number; context_revision: number;
  merchant_id: string; environment: "sandbox" | "live";
};
type Unit = { id: string; packet_id: string; current_version: number | null; accepted_version: number | null };
type Obligation = {
  id: string; unit_id: string; version: number; family_id: string; merchant_id: string;
  environment: string; currency: string; gross: string; collectible: boolean; replaces_id: string | null;
};
type Attempt = {
  id: string; obligation_id: string; initiated_by: string; payer_epoch: number; nomination_epoch: number;
  state: string; order_id: string | null; resolved_at: Date | null; capture_forbidden: boolean;
};
type Operation = {
  id: string; attempt_id: string; kind: "create" | "capture"; request: unknown; request_hash: string;
  provider_key: string; state: "intent" | "admitted" | "pending" | "unknown" | "result";
  lease_token: string | null; lease_generation: number; lease_expires_at: Date | null;
  admitted_at: Date | null; admission: unknown; result: unknown;
};
type Hold = { id: string; reason: string; concern_id: string | null };
type DecisionResult = { unitId: string; version: number; decision: "approve" | "decline"; obligationId: string | null };
export type IntentResult = { attemptId: string; operationId: string; providerKey: string; state: string };
export type DispatchAdmission = {
  dispatchAllowed: boolean; reconciliationRequired: boolean; operationId: string;
  providerKey: string; kind: "create" | "capture"; request: unknown; requestHash: string;
};
type Resolution = { acknowledged: true; concerns: { concernId: string; responseRevision: number }[] };

const commandSchema = z.strictObject({ commandId: commandIdentifier });
const unitVersionSchema = commandSchema.extend({ unitId: identifier, version: revision, digest: digestSchema });
export const publishCommandSchema = commandSchema.extend({ snapshot: publishedUnitSchema, expectedPreviousVersion: revision.nullable() });
const resolutionSchema = z.strictObject({
  acknowledged: z.literal(true),
  concerns: z.array(z.strictObject({ concernId: identifier, responseRevision: revision })).min(1).max(100),
}).refine((value) => new Set(value.concerns.map((entry) => entry.concernId)).size === value.concerns.length, "Duplicate concern");
export const decisionCommandSchema = unitVersionSchema.extend({
  decision: z.enum(["approve", "decline"]),
  attestation: z.strictObject({ reviewedExactVersion: z.literal(true), authority: z.boolean(), statement: text }),
  resolution: resolutionSchema.optional(),
});
export const correctionAdmissionCommandSchema = commandSchema.extend({
  concernId: identifier, packetId: identifier, originUnitId: identifier,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("known"), unitIds: z.array(identifier).min(1).max(100) }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  claim: z.strictObject({
    statement: text, claimedSourceType: text,
    source: z.discriminatedUnion("availability", [
      z.strictObject({ availability: z.literal("unavailable"), explanation: text }),
      z.strictObject({ availability: z.literal("available"), reference: text, date: text.nullable() }),
    ]),
    sharingAuthorized: z.literal(true), modelProcessingPermitted: z.boolean(),
  }),
});
export type PublishCommand = z.infer<typeof publishCommandSchema>;
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
export type CorrectionAdmissionCommand = z.infer<typeof correctionAdmissionCommandSchema>;

function first<T>(rows: readonly T[], message = "Scoped record not found"): T {
  const row = rows[0];
  if (!row) throw new ProtocolError("NOT_FOUND", message);
  return row;
}

function uniqueIds(ids: readonly string[]): string[] {
  if (new Set(ids).size !== ids.length) throw new ProtocolError("INVALID_INPUT", "Duplicate unit identity");
  return [...ids].sort();
}

function financialMeaning(observation: PaymentObservation): string {
  return canonicalJson({
    operationId: observation.operationId, merchantId: observation.merchantId,
    environment: observation.environment, currency: observation.currency, gross: observation.gross,
    orderId: observation.orderId, captureId: observation.captureId ?? null, outcome: observation.outcome,
  });
}

async function fences(transaction: ProtocolTransaction, scope: Scope, exclusiveProject = false): Promise<Project> {
  const workspace = await sql<{ merchant_id: string; environment: "sandbox" | "live" }>`
    select merchant_id, environment from workspaces where id = ${scope.workspaceId} for share
  `.execute(transaction);
  const merchant = first(workspace.rows);
  const projects = await sql<Omit<Project, "merchant_id" | "environment">>`
    select client_id, approver_id, nomination_epoch, context_revision from projects
    where workspace_id = ${scope.workspaceId} and id = ${scope.projectId}
    ${exclusiveProject ? sql`for update` : sql`for share`}
  `.execute(transaction);
  return { ...first(projects.rows), ...merchant };
}

async function authorize(transaction: ProtocolTransaction, actor: Actor, action: Action, project: Project): Promise<void> {
  const grants = await sql<{ epoch: number; active: boolean }>`
    select epoch, active from grants where workspace_id = ${actor.workspaceId} and project_id = ${actor.projectId}
      and actor_id = ${actor.actorId} and action = ${action}
  `.execute(transaction);
  const grant = grants.rows[0];
  if (!grant?.active || grant.epoch !== actor.grantEpoch || (action === "decide" && project.approver_id !== actor.actorId)) {
    throw new ProtocolError("ACCESS_DENIED", "Current scoped authority is required");
  }
}

async function authorizePayer(transaction: ProtocolTransaction, payer: Payer, project: Project): Promise<void> {
  await authorize(transaction, payer, "pay", project);
  const rows = await sql<{ actor_id: string; epoch: number; continuity_epoch: number; active: boolean }>`
    select actor_id, epoch, continuity_epoch, active from payer_nominations
    where workspace_id = ${payer.workspaceId} and project_id = ${payer.projectId} and obligation_id = ${payer.obligationId}
  `.execute(transaction);
  const nomination = rows.rows[0];
  if (!nomination?.active || nomination.actor_id !== payer.actorId || nomination.epoch !== payer.payerEpoch
      || nomination.continuity_epoch !== project.nomination_epoch || payer.nominationEpoch !== project.nomination_epoch) {
    throw new ProtocolError("ACCESS_DENIED", "Current obligation-scoped payer authority and continuity confirmation are required");
  }
}

async function lockPackets(transaction: ProtocolTransaction, scope: Scope, ids: string[], exclusive = false): Promise<void> {
  if (ids.length === 0) return;
  const rows = await sql<{ id: string }>`
    select id from packets where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId}
      and id = any(${[...new Set(ids)].sort()}::text[]) order by id collate "C"
    ${exclusive ? sql`for update` : sql`for share`}
  `.execute(transaction);
  if (rows.rows.length !== new Set(ids).size) throw new ProtocolError("NOT_FOUND", "Scoped packet not found");
}

async function lockUnits(transaction: ProtocolTransaction, scope: Scope, ids: readonly string[]): Promise<Unit[]> {
  const sorted = uniqueIds(ids);
  const descriptors = await sql<Unit>`
    select id, packet_id, current_version, accepted_version from units
    where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = any(${sorted}::text[])
  `.execute(transaction);
  if (descriptors.rows.length !== sorted.length) throw new ProtocolError("NOT_FOUND", "Scoped unit not found");
  await lockPackets(transaction, scope, descriptors.rows.map((row) => row.packet_id));
  const locked = await sql<Unit>`
    select id, packet_id, current_version, accepted_version from units
    where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = any(${sorted}::text[])
    order by id collate "C" for update
  `.execute(transaction);
  return locked.rows;
}

async function history(transaction: ProtocolTransaction, scope: Scope, actorId: string, event: string, resourceId: string, detail: unknown): Promise<void> {
  await sql`insert into protocol_history(workspace_id,project_id,actor_id,event,resource_id,detail)
    values (${scope.workspaceId},${scope.projectId},${actorId},${event},${resourceId},${canonicalJson(detail)}::jsonb)`.execute(transaction);
}

async function activeHolds(transaction: SqlExecutor, scope: Scope, unitId: string): Promise<Hold[]> {
  return (await sql<Hold>`select id, reason, concern_id from holds
    where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and unit_id = ${unitId} and resolved_at is null
    order by id collate "C"`.execute(transaction)).rows;
}

async function checkHolds(transaction: SqlExecutor, scope: Scope, unitId: string, allowedConcerns: readonly string[] = []): Promise<void> {
  const blockers = (await activeHolds(transaction, scope, unitId)).filter(
    (hold) => hold.reason !== "correction" || !hold.concern_id || !allowedConcerns.includes(hold.concern_id),
  );
  if (blockers.length) throw new ProtocolError("REVIEW_HOLD", "Applicable independent holds prevent this admission", blockers.map((hold) => hold.id));
}

async function published(transaction: SqlExecutor, scope: Scope, unitId: string, version: number): Promise<{ snapshot: PublishedUnit; digest: string }> {
  const row = first((await sql<{ snapshot: unknown; digest: string }>`
    select snapshot,digest from unit_versions where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId}
      and unit_id = ${unitId} and version = ${version}
  `.execute(transaction)).rows);
  return { snapshot: parseInput(publishedUnitSchema, row.snapshot), digest: row.digest };
}

async function checkPrerequisites(transaction: SqlExecutor, scope: Scope, snapshot: PublishedUnit, gate: "payment" | "start"): Promise<void> {
  for (const prerequisite of snapshot.prerequisites) {
    if (prerequisite.blocks !== gate && prerequisite.blocks !== "payment-and-start") continue;
    const observation = (await sql<{ satisfied: boolean; prerequisite_version: number }>`
      select satisfied,prerequisite_version from prerequisite_observations
      where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and unit_id = ${snapshot.unitId}
        and version = ${snapshot.version} and prerequisite_id = ${prerequisite.id}
    `.execute(transaction)).rows[0];
    if (!observation?.satisfied || observation.prerequisite_version !== prerequisite.version) {
      throw new ProtocolError("REVIEW_HOLD", "An agreed prerequisite remains unsatisfied", [prerequisite.id]);
    }
  }
}

async function addHold(transaction: ProtocolTransaction, scope: Scope, actorId: string, unitId: string, reason: string, basis: string, concernId: string | null): Promise<void> {
  await sql`insert into holds(workspace_id,project_id,unit_id,id,reason,concern_id,basis,actor_id)
    values (${scope.workspaceId},${scope.projectId},${unitId},${randomUUID()},${reason},${concernId},${basis},${actorId})
    on conflict do nothing`.execute(transaction);
}

export class OrderedConsentStore {
  constructor(
    readonly database: ProtocolDatabase,
    private readonly options: { observationMode?: "authenticated-adapter-only" | "local-synthetic-proof" } = {},
  ) {}

  private async command<T>(
    actorInput: unknown, action: Action, input: { commandId: string }, payload: unknown,
    work: (transaction: ProtocolTransaction, actor: Actor, project: Project) => Promise<T>,
    options: { exclusiveProject?: boolean; payer?: Payer; exactApproverVersion?: { unitId: string; version: number } } = {},
  ): Promise<T> {
    const actor = parseInput(actorSchema, options.payer ? {
      workspaceId: options.payer.workspaceId, projectId: options.payer.projectId,
      actorId: options.payer.actorId, grantEpoch: options.payer.grantEpoch,
    } : actorInput);
    const payloadHash = sha256(canonicalJson({ action, payload }));
    return this.database.transaction(async (transaction) => {
      const project = await fences(transaction, actor, options.exclusiveProject);
      await authorize(transaction, actor, action, project);
      if (options.payer) await authorizePayer(transaction, options.payer, project);
      if (options.exactApproverVersion) {
        const { snapshot } = await published(transaction, actor, options.exactApproverVersion.unitId, options.exactApproverVersion.version);
        if (snapshot.approver.actorId !== actor.actorId || snapshot.approver.nominationEpoch !== project.nomination_epoch) {
          throw new ProtocolError("ACCESS_DENIED", "The named approver epoch changed before command admission or receipt replay");
        }
      }
      // This fence serializes only the same actor/key, never an entire project or unit family.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.workspaceId}/${actor.projectId}/${actor.actorId}/${input.commandId}`},0))`.execute(transaction);
      const receipt = (await sql<{ action: string; payload_hash: string; result: T }>`
        select action,payload_hash,result from command_receipts
        where workspace_id = ${actor.workspaceId} and project_id = ${actor.projectId}
          and actor_id = ${actor.actorId} and command_id = ${input.commandId}::uuid
      `.execute(transaction)).rows[0];
      if (receipt) {
        if (receipt.action !== action || receipt.payload_hash !== payloadHash) {
          throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Command identity was already used with different content");
        }
        return receipt.result;
      }
      const result = await work(transaction, actor, project);
      await sql`insert into command_receipts(workspace_id,project_id,actor_id,command_id,action,payload_hash,result)
        values (${actor.workspaceId},${actor.projectId},${actor.actorId},${input.commandId}::uuid,${action},${payloadHash},${canonicalJson(result)}::jsonb)`.execute(transaction);
      return result;
    });
  }

  async registerContext(actor: Actor, input: unknown): Promise<{ recorded: true }> {
    const command = parseInput(commandSchema.extend({
      baseline: z.strictObject({ id: identifier, version: revision }),
      sources: z.array(z.strictObject({ id: identifier, version: revision, availability: z.enum(["available", "unavailable"]) })).min(1).max(100),
    }), input);
    return this.command(actor, "publish", command, command, async (transaction, current) => {
      if ((await sql`select 1 from units where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} limit 1`.execute(transaction)).rows.length) {
        throw new ProtocolError("STALE_CONTEXT", "Initial context registration must precede unit creation; later material source changes require the correction/reconciliation protocol");
      }
      const baseline = await sql<{ id: string }>`insert into baseline_versions(workspace_id,project_id,id,version,confirmed_by)
        values (${current.workspaceId},${current.projectId},${command.baseline.id},${command.baseline.version},${current.actorId})
        on conflict do nothing returning id`.execute(transaction);
      if (!baseline.rows.length) throw new ProtocolError("INVALID_INPUT", "A confirmed baseline version cannot be overwritten");
      for (const source of command.sources) {
        const inserted = await sql<{ id: string }>`insert into source_versions(workspace_id,project_id,id,version,availability,reviewed_by)
          values (${current.workspaceId},${current.projectId},${source.id},${source.version},${source.availability},${current.actorId})
          on conflict do nothing returning id`.execute(transaction);
        if (!inserted.rows.length) throw new ProtocolError("INVALID_INPUT", "A reviewed source version cannot be overwritten", [source.id]);
      }
      await history(transaction, current, current.actorId, "context-confirmed", command.baseline.id, { sourceCount: command.sources.length });
      return { recorded: true };
    }, { exclusiveProject: true });
  }

  async createPacket(actor: Actor, input: unknown): Promise<{ packetId: string }> {
    const command = parseInput(commandSchema.extend({ packetId: identifier }), input);
    return this.command(actor, "publish", command, command, async (transaction, current) => {
      const inserted = await sql<{ id: string }>`insert into packets(workspace_id,project_id,id)
        values (${current.workspaceId},${current.projectId},${command.packetId}) on conflict do nothing returning id`.execute(transaction);
      if (!inserted.rows.length) throw new ProtocolError("INVALID_INPUT", "This scoped packet identity already exists");
      await history(transaction, current, current.actorId, "packet-created", command.packetId, {});
      return { packetId: command.packetId };
    });
  }

  async createUnit(actor: Actor, input: unknown): Promise<{ unitId: string }> {
    const command = parseInput(commandSchema.extend({ packetId: identifier, unitId: identifier }), input);
    return this.command(actor, "publish", command, command, async (transaction, current) => {
      await lockPackets(transaction, current, [command.packetId], true);
      const inserted = await sql<{ id: string }>`insert into units(workspace_id,project_id,id,packet_id)
        values (${current.workspaceId},${current.projectId},${command.unitId},${command.packetId}) on conflict do nothing returning id`.execute(transaction);
      if (!inserted.rows.length) throw new ProtocolError("INVALID_INPUT", "This scoped unit identity already exists");
      await sql`insert into collection_families(workspace_id,project_id,id)
        values (${current.workspaceId},${current.projectId},${command.unitId})`.execute(transaction);
      const concerns = (await sql<{ id: string }>`select id from corrections
        where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and scope = 'unknown' order by id collate "C"`.execute(transaction)).rows;
      for (const concern of concerns) {
        await addHold(transaction, current, current.actorId, command.unitId, "impact", "New membership requires explicit project-impact review", concern.id);
      }
      await history(transaction, current, current.actorId, "unit-created", command.unitId, { packetId: command.packetId, pendingImpacts: concerns.map((row) => row.id) });
      return { unitId: command.unitId };
    });
  }

  async publish(actor: Actor, input: unknown): Promise<{ unitId: string; version: number; digest: string }> {
    const command = parseInput(publishCommandSchema, input);
    const frozen = freezePublishedUnit(command.snapshot);
    return this.command(actor, "publish", command, command, async (transaction, current, project) => {
      const snapshot = frozen.snapshot;
      if (snapshot.workspaceId !== current.workspaceId || snapshot.projectId !== current.projectId || snapshot.clientId !== project.client_id) {
        throw new ProtocolError("INVALID_INPUT", "Snapshot is not associated with the current project");
      }
      const unit = first(await lockUnits(transaction, current, [snapshot.unitId]));
      if (unit.current_version !== command.expectedPreviousVersion || snapshot.version !== (unit.current_version ?? 0) + 1) {
        throw new ProtocolError("STALE_UNIT_VERSION", "Publication must create the next exact version");
      }
      if (snapshot.contextRevision !== project.context_revision) throw new ProtocolError("STALE_CONTEXT", "Material context changed before publication");
      if (snapshot.approver.actorId !== project.approver_id || snapshot.approver.nominationEpoch !== project.nomination_epoch) {
        throw new ProtocolError("ACCESS_DENIED", "Publication must name the current approver condition");
      }
      if (snapshot.treatment === "payable"
          && (snapshot.payment.financial.merchantId !== project.merchant_id || snapshot.payment.financial.environment !== project.environment)) {
        throw new ProtocolError("INVALID_INPUT", "Merchant and environment must match the workspace");
      }
      if (unit.accepted_version !== null && (snapshot.treatment !== "payable" || snapshot.financialEffect.kind !== "unpaid-replacement")) {
        throw new ProtocolError("COLLECTION_CONFLICT", "Accepted terms require an explicit supported unpaid-replacement financial basis");
      }
      for (const concern of snapshot.reconciliation) await this.response(transaction, current, snapshot.unitId, concern.concernId, concern.responseRevision);
      await checkHolds(transaction, current, snapshot.unitId, snapshot.reconciliation.map((entry) => entry.concernId));
      for (const reference of snapshot.baselineReferences) {
        const found = (await sql`select 1 from baseline_versions where workspace_id = ${current.workspaceId} and project_id = ${current.projectId}
          and id = ${reference.id} and version = ${reference.version}`.execute(transaction)).rows.length;
        if (!found) throw new ProtocolError("INVALID_INPUT", "Baseline reference is not confirmed in this project", [reference.id]);
      }
      for (const reference of snapshot.sourceReferences) {
        const found = (await sql<{ availability: string }>`select availability from source_versions
          where workspace_id = ${current.workspaceId} and project_id = ${current.projectId}
            and id = ${reference.id} and version = ${reference.version}`.execute(transaction)).rows[0];
        if (!found || found.availability !== reference.availability) throw new ProtocolError("INVALID_INPUT", "Source reference is not reviewed in this project", [reference.id]);
      }
      for (const dependency of snapshot.dependencies) {
        if (!(await sql`select 1 from units where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and id = ${dependency.unitId}`.execute(transaction)).rows.length) {
          throw new ProtocolError("INVALID_INPUT", "Dependency is outside this project", [dependency.unitId]);
        }
      }
      await sql`insert into unit_versions(workspace_id,project_id,unit_id,version,snapshot,canonical_bytes,digest,published_by)
        values (${current.workspaceId},${current.projectId},${snapshot.unitId},${snapshot.version},${canonicalJson(snapshot)}::jsonb,${frozen.bytes},${frozen.digest},${current.actorId})`.execute(transaction);
      for (const reference of snapshot.sourceReferences) {
        await sql`insert into version_sources(workspace_id,project_id,unit_id,version,source_id,source_version)
          values (${current.workspaceId},${current.projectId},${snapshot.unitId},${snapshot.version},${reference.id},${reference.version})`.execute(transaction);
      }
      for (const reference of snapshot.baselineReferences) {
        await sql`insert into version_baselines(workspace_id,project_id,unit_id,version,baseline_id,baseline_version)
          values (${current.workspaceId},${current.projectId},${snapshot.unitId},${snapshot.version},${reference.id},${reference.version})`.execute(transaction);
      }
      await sql`update units set current_version = ${snapshot.version}
        where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and id = ${snapshot.unitId}`.execute(transaction);
      await history(transaction, current, current.actorId, "published", snapshot.unitId, { version: snapshot.version, digest: frozen.digest });
      return { unitId: snapshot.unitId, version: snapshot.version, digest: frozen.digest };
    });
  }

  private async response(transaction: ProtocolTransaction, scope: Scope, unitId: string, concernId: string, responseRevision: number): Promise<void> {
    const response = (await sql<{ disposition: string; latest: number }>`select disposition,
        (select max(revision) from correction_responses r2 where r2.workspace_id = r.workspace_id and r2.project_id = r.project_id and r2.concern_id = r.concern_id) as latest
      from correction_responses r where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId}
        and concern_id = ${concernId} and revision = ${responseRevision}`.execute(transaction)).rows[0];
    const hold = (await activeHolds(transaction, scope, unitId)).some((row) => row.reason === "correction" && row.concern_id === concernId);
    if (!response || response.disposition === "request-information" || response.latest !== responseRevision || !hold) {
      throw new ProtocolError("STALE_CONTEXT", "An identified active correction and its current reconciled response are required", [concernId]);
    }
  }

  async decide(actor: Actor, input: unknown): Promise<DecisionResult> {
    const command = parseInput(decisionCommandSchema, input);
    if (command.decision === "approve" && !command.attestation.authority) throw new ProtocolError("INVALID_INPUT", "Approval requires an explicit authority attestation");
    const obligationId = randomUUID();
    return this.command(actor, "decide", command, command, async (transaction, current, project) => {
      const unit = first(await lockUnits(transaction, current, [command.unitId]));
      const version = await published(transaction, current, command.unitId, command.version);
      if (version.digest !== command.digest) throw new ProtocolError("STALE_UNIT_VERSION", "Digest differs from the exact published bytes");
      if (version.snapshot.approver.actorId !== current.actorId || version.snapshot.approver.nominationEpoch !== project.nomination_epoch) {
        throw new ProtocolError("ACCESS_DENIED", "The named approver condition changed; review a reissued version");
      }
      const existing = (await sql<{ decision: "approve" | "decline" }>`select decision from decisions
        where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and unit_id = ${command.unitId} and version = ${command.version}`.execute(transaction)).rows[0];
      if (existing) {
        if (existing.decision !== command.decision) throw new ProtocolError("DECISION_CONFLICT", "A different terminal decision already exists");
        const obligation = (await sql<{ id: string }>`select id from obligations
          where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and unit_id = ${command.unitId} and version = ${command.version}`.execute(transaction)).rows[0];
        return { unitId: command.unitId, version: command.version, decision: existing.decision, obligationId: obligation?.id ?? null };
      }
      if (unit.current_version !== command.version) throw new ProtocolError("STALE_UNIT_VERSION", "This unaccepted offer was replaced");
      if (command.resolution) {
        await this.resolveIdentified(transaction, current, version.snapshot, command.resolution);
      }
      if (command.decision === "approve") await checkHolds(transaction, current, command.unitId);
      const snapshot = version.snapshot;
      let newObligationId: string | null = null;
      if (command.decision === "approve" && snapshot.treatment === "payable") {
        await sql`select id from collection_families where workspace_id = ${current.workspaceId}
          and project_id = ${current.projectId} and id = ${command.unitId} for update`.execute(transaction);
        const previous = (await sql<Obligation>`select * from obligations where workspace_id = ${current.workspaceId}
          and project_id = ${current.projectId} and family_id = ${command.unitId} and collectible for update`.execute(transaction)).rows[0];
        if (snapshot.financialEffect.kind === "unpaid-replacement") {
          if (!previous || previous.id !== snapshot.financialEffect.replacesObligationId) throw new ProtocolError("COLLECTION_CONFLICT", "The replacement must identify the active original obligation");
          const attempts = await sql`select id from attempts where workspace_id = ${current.workspaceId} and project_id = ${current.projectId}
            and obligation_id = ${previous.id} for update`.execute(transaction);
          if (attempts.rows.length) throw new ProtocolError("PAYMENT_OUTCOME_UNKNOWN", "Prior financial attempts require reconciliation; create-only retirement is disabled");
          await sql`update obligations set collectible = false where workspace_id = ${current.workspaceId}
            and project_id = ${current.projectId} and id = ${previous.id}`.execute(transaction);
        } else if (previous || unit.accepted_version !== null) {
          throw new ProtocolError("COLLECTION_CONFLICT", "A new version cannot create overlapping collection");
        }
        newObligationId = obligationId;
      }
      await sql`insert into decisions(workspace_id,project_id,unit_id,version,decision,actor_id,nomination_epoch,digest,attestation,resolution)
        values (${current.workspaceId},${current.projectId},${command.unitId},${command.version},${command.decision},${current.actorId},
          ${project.nomination_epoch},${command.digest},${canonicalJson(command.attestation)}::jsonb,
          ${command.resolution ? canonicalJson(command.resolution) : null}::jsonb)`.execute(transaction);
      if (newObligationId && snapshot.treatment === "payable") {
        const financial = snapshot.payment.financial;
        await sql`insert into obligations(workspace_id,project_id,id,unit_id,version,family_id,merchant_id,environment,currency,gross,replaces_id)
          values (${current.workspaceId},${current.projectId},${newObligationId},${command.unitId},${command.version},${command.unitId},
            ${financial.merchantId},${financial.environment},${financial.currency},${financial.gross},
            ${snapshot.financialEffect.kind === "unpaid-replacement" ? snapshot.financialEffect.replacesObligationId : null})`.execute(transaction);
      }
      if (command.decision === "approve") {
        await sql`update units set accepted_version = ${command.version} where workspace_id = ${current.workspaceId}
          and project_id = ${current.projectId} and id = ${command.unitId}`.execute(transaction);
      }
      await history(transaction, current, current.actorId, "decision", command.unitId, {
        version: command.version, decision: command.decision, obligationId: newObligationId,
        resolvedConcerns: command.resolution?.concerns.map((row) => row.concernId) ?? [],
      });
      return { unitId: command.unitId, version: command.version, decision: command.decision, obligationId: newObligationId };
    }, { exactApproverVersion: { unitId: command.unitId, version: command.version } });
  }

  private async resolveIdentified(transaction: ProtocolTransaction, actor: Actor, snapshot: PublishedUnit, resolution: Resolution, requirePublishedResponse = true): Promise<void> {
    for (const concern of resolution.concerns) {
      if (requirePublishedResponse && !snapshot.reconciliation.some((entry) => entry.concernId === concern.concernId && entry.responseRevision === concern.responseRevision)) {
        throw new ProtocolError("STALE_CONTEXT", "The exact version must identify this response and concern", [concern.concernId]);
      }
      await this.response(transaction, actor, snapshot.unitId, concern.concernId, concern.responseRevision);
    }
    for (const concern of resolution.concerns) {
      await sql`update holds set resolved_at = clock_timestamp(), resolved_by = ${actor.actorId},
        resolution_basis = ${canonicalJson({ version: snapshot.version, responseRevision: concern.responseRevision, acknowledged: true })}::jsonb
        where workspace_id = ${actor.workspaceId} and project_id = ${actor.projectId} and unit_id = ${snapshot.unitId}
          and concern_id = ${concern.concernId} and reason = 'correction' and resolved_at is null`.execute(transaction);
    }
  }

  async resolveAcceptedConcern(actor: Actor, input: unknown): Promise<{ resolved: true }> {
    const command = parseInput(unitVersionSchema.extend({
      resolution: resolutionSchema,
      attestation: z.strictObject({ reviewedExactVersion: z.literal(true), authority: z.literal(true), statement: text }),
    }), input);
    return this.command(actor, "decide", command, command, async (transaction, current) => {
      const unit = first(await lockUnits(transaction, current, [command.unitId]));
      const version = await published(transaction, current, command.unitId, command.version);
      if (unit.accepted_version !== command.version || version.digest !== command.digest) {
        throw new ProtocolError("STALE_UNIT_VERSION", "Concern resolution must identify the unchanged accepted version");
      }
      await this.resolveIdentified(transaction, current, version.snapshot, command.resolution, false);
      await history(transaction, current, current.actorId, "accepted-concern-resolved", command.unitId, {
        version: command.version, concerns: command.resolution.concerns, attestation: command.attestation,
      });
      return { resolved: true };
    });
  }

  async admitCorrection(actor: Actor, input: unknown): Promise<{ concernId: string; impactRevision: number; affectedUnitIds: string[] }> {
    const command = parseInput(correctionAdmissionCommandSchema, input);
    const known = command.scope.kind === "known" ? uniqueIds(command.scope.unitIds) : null;
    if (known && !known.includes(command.originUnitId)) throw new ProtocolError("INVALID_INPUT", "Known correction scope must include its originating unit");
    return this.command(actor, "correct", command, command, async (transaction, current, project) => {
      if (!known) await lockPackets(transaction, current, [command.packetId], true);
      const ids = known ?? (await sql<{ id: string }>`select id from units where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} order by id collate "C"`.execute(transaction)).rows.map((row) => row.id);
      const units = await lockUnits(transaction, current, ids);
      const origin = units.find((row) => row.id === command.originUnitId);
      if (!origin || origin.packet_id !== command.packetId) throw new ProtocolError("INVALID_INPUT", "Correction origin must belong to its scoped packet");
      const impactRevision = known ? project.context_revision : project.context_revision + 1;
      if (!known) await sql`update projects set context_revision = ${impactRevision}
        where workspace_id = ${current.workspaceId} and id = ${current.projectId}`.execute(transaction);
      await sql`insert into corrections(workspace_id,project_id,id,packet_id,origin_unit_id,scope,impact_revision,claim,actor_id)
        values (${current.workspaceId},${current.projectId},${command.concernId},${command.packetId},${command.originUnitId},
          ${known ? "known" : "unknown"},${impactRevision},${canonicalJson(command.claim)}::jsonb,${current.actorId})`.execute(transaction);
      for (const unit of units) {
        await addHold(transaction, current, current.actorId, unit.id, known || unit.id === command.originUnitId ? "correction" : "impact", "Durably admitted material or uncertain context correction", command.concernId);
      }
      await history(transaction, current, current.actorId, "correction-admitted", command.concernId, { impactRevision, affectedUnitIds: ids });
      return { concernId: command.concernId, impactRevision, affectedUnitIds: ids };
    }, { exclusiveProject: !known });
  }

  async reviewImpact(actor: Actor, input: unknown): Promise<{ reviewed: true }> {
    const command = parseInput(commandSchema.extend({
      concernId: identifier, impactRevision: revision,
      reviews: z.array(z.strictObject({ unitId: identifier, disposition: z.enum(["independent", "affected"]), explanation: text })).min(1).max(100),
    }), input);
    return this.command(actor, "review", command, command, async (transaction, current) => {
      const correction = first((await sql<{ origin_unit_id: string; impact_revision: number; scope: string }>`
        select origin_unit_id,impact_revision,scope from corrections where workspace_id = ${current.workspaceId}
          and project_id = ${current.projectId} and id = ${command.concernId}`.execute(transaction)).rows);
      if (correction.scope !== "unknown" || correction.impact_revision !== command.impactRevision) throw new ProtocolError("STALE_CONTEXT", "Impact review revision differs");
      await lockUnits(transaction, current, command.reviews.map((row) => row.unitId));
      for (const review of command.reviews) {
        if (review.unitId === correction.origin_unit_id && review.disposition === "independent") {
          throw new ProtocolError("INVALID_INPUT", "Independence cannot dismiss the originating material concern");
        }
        const hold = (await activeHolds(transaction, current, review.unitId)).find((row) => row.concern_id === command.concernId && row.reason === "impact");
        if (!hold) throw new ProtocolError("STALE_CONTEXT", "Only an outstanding provisional impact can be assessed");
        await sql`insert into impact_reviews(workspace_id,project_id,concern_id,unit_id,impact_revision,disposition,explanation,actor_id)
          values (${current.workspaceId},${current.projectId},${command.concernId},${review.unitId},${command.impactRevision},${review.disposition},${review.explanation},${current.actorId})`.execute(transaction);
        await sql`update holds set resolved_at = clock_timestamp(), resolved_by = ${current.actorId}, resolution_basis = ${canonicalJson(review)}::jsonb
          where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and unit_id = ${review.unitId} and id = ${hold.id}`.execute(transaction);
        if (review.disposition === "affected") await addHold(transaction, current, current.actorId, review.unitId, "correction", review.explanation, command.concernId);
      }
      await history(transaction, current, current.actorId, "impact-reviewed", command.concernId, { unitIds: command.reviews.map((row) => row.unitId) });
      return { reviewed: true };
    });
  }

  async respondToCorrection(actor: Actor, input: unknown): Promise<{ responseRevision: number }> {
    const command = parseInput(commandSchema.extend({
      concernId: identifier, responseRevision: revision,
      disposition: z.enum(["accept", "partial", "maintain", "request-information"]),
      sourceReview: text, explanation: text,
    }), input);
    return this.command(actor, "review", command, command, async (transaction, current) => {
      const correction = first((await sql<{ origin_unit_id: string }>`select origin_unit_id from corrections
        where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and id = ${command.concernId}`.execute(transaction)).rows);
      const affected = (await sql<{ unit_id: string }>`select distinct unit_id collate "C" as unit_id from holds where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} and concern_id = ${command.concernId} order by unit_id collate "C"`.execute(transaction)).rows.map((row) => row.unit_id);
      await lockUnits(transaction, current, affected.length ? affected : [correction.origin_unit_id]);
      const latest = (await sql<{ latest: number | null }>`select max(revision) as latest from correction_responses
        where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and concern_id = ${command.concernId}`.execute(transaction)).rows[0]?.latest ?? 0;
      if (command.responseRevision !== latest + 1) throw new ProtocolError("STALE_CONTEXT", "Response must use the next exact revision");
      await sql`insert into correction_responses(workspace_id,project_id,concern_id,revision,disposition,source_review,explanation,actor_id)
        values (${current.workspaceId},${current.projectId},${command.concernId},${command.responseRevision},${command.disposition},${command.sourceReview},${command.explanation},${current.actorId})`.execute(transaction);
      await history(transaction, current, current.actorId, "correction-responded", command.concernId, { revision: command.responseRevision, disposition: command.disposition });
      return { responseRevision: command.responseRevision };
    });
  }

  async placeIndependentHold(actor: Actor, input: unknown): Promise<{ recorded: true }> {
    const command = parseInput(commandSchema.extend({ unitId: identifier, reason: z.enum(["source", "stop", "financial", "restore"]), basis: text }), input);
    return this.command(actor, "review", command, command, async (transaction, current) => {
      await lockUnits(transaction, current, [command.unitId]);
      await addHold(transaction, current, current.actorId, command.unitId, command.reason, command.basis, null);
      await history(transaction, current, current.actorId, "independent-hold", command.unitId, { reason: command.reason });
      return { recorded: true };
    });
  }

  async setGrant(actor: Actor, input: unknown): Promise<{ grantEpoch: number }> {
    const command = parseInput(commandSchema.extend({
      targetActorId: identifier, action: z.enum(["publish", "decide", "correct", "nominate", "review", "pay", "inspect"]), active: z.boolean(), basis: text,
    }), input);
    return this.command(actor, "nominate", command, command, async (transaction, current) => {
      const row = first((await sql<{ epoch: number }>`insert into grants(workspace_id,project_id,actor_id,action,active)
        values (${current.workspaceId},${current.projectId},${command.targetActorId},${command.action},${command.active})
        on conflict (workspace_id,project_id,actor_id,action) do update set epoch = grants.epoch + 1, active = excluded.active returning epoch`.execute(transaction)).rows);
      await history(transaction, current, current.actorId, "grant-changed", command.targetActorId, { action: command.action, active: command.active, basis: command.basis, epoch: row.epoch });
      return { grantEpoch: row.epoch };
    }, { exclusiveProject: true });
  }

  async replaceApprover(actor: Actor, input: unknown): Promise<{ nominationEpoch: number }> {
    const command = parseInput(commandSchema.extend({ approverId: identifier, expectedEpoch: revision, basis: text }), input);
    return this.command(actor, "nominate", command, command, async (transaction, current, project) => {
      if (project.nomination_epoch !== command.expectedEpoch || project.approver_id === command.approverId) throw new ProtocolError("STALE_CONTEXT", "Approver nomination changed or is unchanged");
      const epoch = project.nomination_epoch + 1;
      await sql`update projects set approver_id = ${command.approverId}, nomination_epoch = ${epoch}
        where workspace_id = ${current.workspaceId} and id = ${current.projectId}`.execute(transaction);
      await sql`update grants set active = false, epoch = epoch + 1 where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} and actor_id = ${project.approver_id} and action = 'decide'`.execute(transaction);
      await sql`insert into grants(workspace_id,project_id,actor_id,action) values (${current.workspaceId},${current.projectId},${command.approverId},'decide')
        on conflict (workspace_id,project_id,actor_id,action) do update set active = true, epoch = grants.epoch + 1`.execute(transaction);
      await history(transaction, current, current.actorId, "approver-replaced", command.approverId, { previousActorId: project.approver_id, epoch, basis: command.basis });
      return { nominationEpoch: epoch };
    }, { exclusiveProject: true });
  }

  async nominatePayer(actor: Actor, input: unknown): Promise<{ payerEpoch: number; nominationEpoch: number }> {
    const command = parseInput(commandSchema.extend({
      obligationId: identifier, payerId: identifier, active: z.boolean(), continuityConfirmed: z.literal(true), basis: text,
    }), input);
    // Both the authorized nomination manager and the current approver use explicit, separate grants.
    return this.command(actor, "nominate", command, command, async (transaction, current, project) => {
      const obligation = first((await sql<Obligation>`select * from obligations where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} and id = ${command.obligationId}`.execute(transaction)).rows);
      await lockUnits(transaction, current, [obligation.unit_id]);
      const nomination = first((await sql<{ epoch: number }>`insert into payer_nominations
        (workspace_id,project_id,obligation_id,actor_id,epoch,continuity_epoch,active,nominated_by,basis)
        values (${current.workspaceId},${current.projectId},${command.obligationId},${command.payerId},1,${project.nomination_epoch},${command.active},${current.actorId},${command.basis})
        on conflict (workspace_id,project_id,obligation_id) do update set actor_id = excluded.actor_id, epoch = payer_nominations.epoch + 1,
          continuity_epoch = excluded.continuity_epoch, active = excluded.active, nominated_by = excluded.nominated_by, basis = excluded.basis returning epoch`.execute(transaction)).rows);
      await history(transaction, current, current.actorId, "payer-nominated", command.obligationId, { payerId: command.payerId, active: command.active, payerEpoch: nomination.epoch, continuityEpoch: project.nomination_epoch, basis: command.basis });
      return { payerEpoch: nomination.epoch, nominationEpoch: project.nomination_epoch };
    }, { exclusiveProject: true });
  }

  async observePrerequisite(actor: Actor, input: unknown): Promise<{ recorded: true }> {
    const command = parseInput(commandSchema.extend({
      unitId: identifier, version: revision, prerequisiteId: identifier, prerequisiteVersion: revision, satisfied: z.boolean(), basis: text,
    }), input);
    return this.command(actor, "inspect", command, command, async (transaction, current) => {
      await lockUnits(transaction, current, [command.unitId]);
      const { snapshot } = await published(transaction, current, command.unitId, command.version);
      const condition = snapshot.prerequisites.find((row) => row.id === command.prerequisiteId && row.version === command.prerequisiteVersion);
      if (!condition || condition.recorderId !== current.actorId) throw new ProtocolError("ACCESS_DENIED", "Only the frozen prerequisite recorder may record satisfaction or retraction");
      await sql`insert into prerequisite_observations(workspace_id,project_id,unit_id,version,prerequisite_id,prerequisite_version,actor_id,satisfied,basis)
        values (${current.workspaceId},${current.projectId},${command.unitId},${command.version},${command.prerequisiteId},${command.prerequisiteVersion},${current.actorId},${command.satisfied},${command.basis})
        on conflict (workspace_id,project_id,unit_id,version,prerequisite_id) do update set actor_id = excluded.actor_id,
          satisfied = excluded.satisfied, basis = excluded.basis, recorded_at = clock_timestamp()`.execute(transaction);
      await history(transaction, current, current.actorId, "prerequisite-observed", command.unitId, { conditionId: condition.id, satisfied: command.satisfied, basis: command.basis });
      return { recorded: true };
    });
  }

  private async financialLocks(transaction: ProtocolTransaction, scope: Scope, obligationId: string): Promise<{ obligation: Obligation; unit: Unit; snapshot: PublishedUnit }> {
    const descriptor = first((await sql<Obligation>`select * from obligations where workspace_id = ${scope.workspaceId}
      and project_id = ${scope.projectId} and id = ${obligationId}`.execute(transaction)).rows);
    const unit = first(await lockUnits(transaction, scope, [descriptor.unit_id]));
    await sql`select id from collection_families where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${descriptor.family_id} for update`.execute(transaction);
    const obligation = first((await sql<Obligation>`select * from obligations where workspace_id = ${scope.workspaceId}
      and project_id = ${scope.projectId} and id = ${obligationId} for update`.execute(transaction)).rows);
    const { snapshot } = await published(transaction, scope, obligation.unit_id, obligation.version);
    return { obligation, unit, snapshot };
  }

  private async financialEligibility(transaction: ProtocolTransaction, scope: Scope, project: Project, obligation: Obligation, unit: Unit, snapshot: PublishedUnit): Promise<void> {
    if (!obligation.collectible || unit.accepted_version !== obligation.version || snapshot.treatment !== "payable") throw new ProtocolError("COLLECTION_CONFLICT", "This obligation is no longer the active approved financial basis");
    if (obligation.merchant_id !== project.merchant_id || obligation.environment !== project.environment
      || snapshot.payment.financial.gross !== obligation.gross || snapshot.payment.financial.currency !== obligation.currency) {
      throw new ProtocolError("FINANCIAL_MISMATCH", "Frozen obligation identity does not match the workspace and approved version");
    }
    await checkHolds(transaction, scope, unit.id);
    await checkPrerequisites(transaction, scope, snapshot, "payment");
  }

  async initiatePayment(payerInput: Payer, input: unknown): Promise<IntentResult> {
    const payer = parseInput(payerSchema, payerInput);
    const command = parseInput(commandSchema, input);
    const attemptId = randomUUID();
    const operationId = randomUUID();
    return this.command(payer, "pay", command, { ...command, payer }, async (transaction, current, project) => {
      const { obligation, unit, snapshot } = await this.financialLocks(transaction, current, payer.obligationId);
      await this.financialEligibility(transaction, current, project, obligation, unit, snapshot);
      const existing = (await sql<Attempt>`select * from attempts where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} and obligation_id = ${obligation.id} and resolved_at is null for update`.execute(transaction)).rows[0];
      if (existing) {
        const operation = first((await sql<Operation>`select * from operations where workspace_id = ${current.workspaceId}
          and project_id = ${current.projectId} and attempt_id = ${existing.id}::uuid and kind = 'create' for update`.execute(transaction)).rows);
        return this.intentResult(existing, operation);
      }
      if ((await sql`select 1 from attempts where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and obligation_id = ${obligation.id}`.execute(transaction)).rows.length) {
        throw new ProtocolError("COLLECTION_CONFLICT", "This obligation already has a financial attempt; no automatic recollection");
      }
      await sql`insert into attempts(workspace_id,project_id,id,obligation_id,initiated_by,payer_epoch,nomination_epoch,state)
        values (${current.workspaceId},${current.projectId},${attemptId}::uuid,${obligation.id},${current.actorId},${payer.payerEpoch},${project.nomination_epoch},'intent')`.execute(transaction);
      const request = this.operationRequest(obligation, "create", null);
      await this.insertOperation(transaction, current, operationId, attemptId, "create", request);
      await history(transaction, current, current.actorId, "payment-intent", operationId, { attemptId, obligationId: obligation.id, kind: "create" });
      return { attemptId, operationId, providerKey: operationId, state: "intent" };
    }, { payer });
  }

  private intentResult(attempt: Attempt, operation: Operation): IntentResult {
    return { attemptId: attempt.id, operationId: operation.id, providerKey: operation.provider_key, state: operation.state };
  }

  private operationRequest(obligation: Obligation, kind: "create" | "capture", orderId: string | null): unknown {
    return {
      schemaVersion: "scopeledger.payment-operation.v1", obligationId: obligation.id, unitId: obligation.unit_id,
      version: obligation.version, kind, merchantId: obligation.merchant_id, environment: obligation.environment,
      currency: obligation.currency, gross: obligation.gross, orderId,
    };
  }

  private async insertOperation(transaction: ProtocolTransaction, scope: Scope, operationId: string, attemptId: string, kind: "create" | "capture", request: unknown): Promise<void> {
    const canonical = canonicalJson(request);
    await sql`insert into operations(workspace_id,project_id,id,attempt_id,kind,request,request_hash,provider_key,state)
      values (${scope.workspaceId},${scope.projectId},${operationId}::uuid,${attemptId}::uuid,${kind},${canonical}::jsonb,${sha256(canonical)},${operationId}::uuid,'intent')`.execute(transaction);
  }

  async requestCapture(payerInput: Payer, input: unknown): Promise<IntentResult> {
    const payer = parseInput(payerSchema, payerInput);
    const command = parseInput(commandSchema.extend({ attemptId: commandIdentifier, orderId: identifier }), input);
    const operationId = randomUUID();
    return this.command(payer, "pay", command, { ...command, payer }, async (transaction, current, project) => {
      const { obligation, unit, snapshot } = await this.financialLocks(transaction, current, payer.obligationId);
      await this.financialEligibility(transaction, current, project, obligation, unit, snapshot);
      const attempt = first((await sql<Attempt>`select * from attempts where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} and id = ${command.attemptId}::uuid and obligation_id = ${obligation.id} for update`.execute(transaction)).rows);
      if (attempt.order_id !== command.orderId || attempt.resolved_at || attempt.capture_forbidden) throw new ProtocolError("RECONCILIATION_REQUIRED", "Capture requires the original known, unresolved, permitted Order");
      const existing = (await sql<Operation>`select * from operations where workspace_id = ${current.workspaceId}
        and project_id = ${current.projectId} and attempt_id = ${attempt.id}::uuid and kind = 'capture' for update`.execute(transaction)).rows[0];
      if (existing) return this.intentResult(attempt, existing);
      if (attempt.state !== "order-available") throw new ProtocolError("RECONCILIATION_REQUIRED", "Create outcome is not established");
      await this.insertOperation(transaction, current, operationId, attempt.id, "capture", this.operationRequest(obligation, "capture", command.orderId));
      await sql`update attempts set state = 'capture-intent' where workspace_id = ${current.workspaceId} and project_id = ${current.projectId} and id = ${attempt.id}::uuid`.execute(transaction);
      await history(transaction, current, current.actorId, "payment-intent", operationId, { attemptId: attempt.id, kind: "capture" });
      return { attemptId: attempt.id, operationId, providerKey: operationId, state: "intent" };
    }, { payer });
  }

  /** Worker-only: a lease is not dispatch authority. Admission below rechecks all current fences. */
  async claimOperation(scopeInput: Scope, input: unknown): Promise<Lease> {
    const scope = parseInput(z.strictObject({ workspaceId: identifier, projectId: identifier }), scopeInput);
    const command = parseInput(z.strictObject({ operationId: commandIdentifier, leaseMilliseconds: z.number().int().min(1).max(60_000) }), input);
    const token = randomUUID();
    return this.database.transaction(async (transaction) => {
      await fences(transaction, scope);
      const descriptor = await this.operationDescriptor(transaction, scope, command.operationId);
      await this.financialLocks(transaction, scope, descriptor.obligation_id);
      await sql`select id from attempts where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${descriptor.attempt_id}::uuid for update`.execute(transaction);
      const operation = first((await sql<Operation>`select * from operations where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId} and id = ${command.operationId}::uuid for update`.execute(transaction)).rows);
      if (operation.state !== "intent" || operation.admitted_at) throw new ProtocolError("RECONCILIATION_REQUIRED", "An operation that may have been admitted cannot receive fresh dispatch permission");
      const claimed = (await sql<{ lease_generation: number }>`update operations
        set lease_token = ${token}::uuid, lease_generation = lease_generation + 1,
          lease_expires_at = clock_timestamp() + ${command.leaseMilliseconds} * interval '1 millisecond'
        where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${command.operationId}::uuid
          and (lease_expires_at is null or lease_expires_at <= clock_timestamp()) returning lease_generation`.execute(transaction)).rows[0];
      if (!claimed) throw new ProtocolError("STALE_LEASE", "A current worker already holds this intent lease");
      return { ...scope, operationId: operation.id, token, generation: claimed.lease_generation };
    });
  }

  private async operationDescriptor(transaction: ProtocolTransaction, scope: Scope, operationId: string): Promise<{ attempt_id: string; obligation_id: string }> {
    return first((await sql<{ attempt_id: string; obligation_id: string }>`select o.attempt_id,a.obligation_id
      from operations o join attempts a on a.workspace_id = o.workspace_id and a.project_id = o.project_id and a.id = o.attempt_id
      where o.workspace_id = ${scope.workspaceId} and o.project_id = ${scope.projectId} and o.id = ${operationId}::uuid`.execute(transaction)).rows);
  }

  async captureReconciliationAdmission(
    scopeInput: Scope,
    orderIdInput: unknown,
  ): Promise<DispatchAdmission> {
    const scope = parseInput(
      z.strictObject({ workspaceId: identifier, projectId: identifier }),
      scopeInput,
    );
    const orderId = parseInput(identifier, orderIdInput);
    return this.database.transaction(async (transaction) => {
      await fences(transaction, scope);
      const operations = await sql<Operation>`select o.*
        from attempts a join operations o
          on o.workspace_id = a.workspace_id
          and o.project_id = a.project_id
          and o.attempt_id = a.id
        where a.workspace_id = ${scope.workspaceId}
          and a.project_id = ${scope.projectId}
          and a.order_id = ${orderId}
          and o.kind = 'capture'
        order by o.created_at desc
        for update of o`.execute(transaction);
      if (operations.rows.length !== 1) {
        throw new ProtocolError(
          "RECONCILIATION_REQUIRED",
          "Expected one capture operation for the verified PayPal Order",
        );
      }
      const operation = first(operations.rows);
      if (!operation.admitted_at) {
        throw new ProtocolError(
          "RECONCILIATION_REQUIRED",
          "Webhook reconciliation cannot manufacture an unadmitted capture",
        );
      }
      return {
        dispatchAllowed: false,
        reconciliationRequired: true,
        operationId: operation.id,
        providerKey: operation.provider_key,
        kind: operation.kind,
        request: operation.request,
        requestHash: operation.request_hash,
      };
    });
  }

  async admitDispatch(leaseInput: Lease, payerInput: Payer): Promise<DispatchAdmission> {
    const lease = parseInput(leaseSchema, leaseInput);
    const payer = parseInput(payerSchema, payerInput);
    if (lease.workspaceId !== payer.workspaceId || lease.projectId !== payer.projectId) throw new ProtocolError("ACCESS_DENIED", "Lease and payer scope differ");
    return this.database.transaction(async (transaction) => {
      const project = await fences(transaction, lease);
      await authorizePayer(transaction, payer, project);
      const descriptor = await this.operationDescriptor(transaction, lease, lease.operationId);
      if (descriptor.obligation_id !== payer.obligationId) throw new ProtocolError("ACCESS_DENIED", "Payer grant does not cover this operation");
      const { obligation, unit, snapshot } = await this.financialLocks(transaction, lease, descriptor.obligation_id);
      const attempt = first((await sql<Attempt>`select * from attempts where workspace_id = ${lease.workspaceId}
        and project_id = ${lease.projectId} and id = ${descriptor.attempt_id}::uuid for update`.execute(transaction)).rows);
      const operation = first((await sql<Operation>`select * from operations where workspace_id = ${lease.workspaceId}
        and project_id = ${lease.projectId} and id = ${lease.operationId}::uuid for update`.execute(transaction)).rows);
      const base = { operationId: operation.id, providerKey: operation.provider_key, kind: operation.kind, request: operation.request, requestHash: operation.request_hash };
      if (operation.admitted_at || operation.state !== "intent") return { ...base, dispatchAllowed: false, reconciliationRequired: true };
      await this.financialEligibility(transaction, lease, project, obligation, unit, snapshot);
      if (attempt.resolved_at || attempt.capture_forbidden || sha256(canonicalJson(operation.request)) !== operation.request_hash) throw new ProtocolError("RECONCILIATION_REQUIRED", "Attempt or stable operation identity is not eligible");
      if (operation.kind === "capture" && !attempt.order_id) throw new ProtocolError("RECONCILIATION_REQUIRED", "No original Order linkage");
      const admitted = (await sql<{ id: string }>`update operations set admitted_at = clock_timestamp(), state = 'admitted',
          admission = ${canonicalJson({ payerId: payer.actorId, payerEpoch: payer.payerEpoch, nominationEpoch: project.nomination_epoch, generation: lease.generation })}::jsonb
        where workspace_id = ${lease.workspaceId} and project_id = ${lease.projectId} and id = ${lease.operationId}::uuid
          and lease_token = ${lease.token}::uuid and lease_generation = ${lease.generation}
          and lease_expires_at > clock_timestamp() returning id`.execute(transaction)).rows[0];
      if (!admitted) throw new ProtocolError("STALE_LEASE", "The dispatch lease expired or was replaced before admission");
      await sql`update attempts set state = ${operation.kind === "capture" ? "capture-admitted" : "create-admitted"}
        where workspace_id = ${lease.workspaceId} and project_id = ${lease.projectId} and id = ${attempt.id}::uuid`.execute(transaction);
      await history(transaction, lease, payer.actorId, "dispatch-admitted", operation.id, { kind: operation.kind, attemptId: attempt.id, generation: lease.generation });
      return { ...base, dispatchAllowed: true, reconciliationRequired: false };
    });
  }

  /** The transport is called only after COMMIT; it is never part of transaction retry. */
  async dispatch(
    lease: Lease, payer: Payer, transport: (admission: DispatchAdmission) => Promise<PaymentObservation>,
  ): Promise<DispatchAdmission> {
    const admission = await this.admitDispatch(lease, payer);
    if (!admission.dispatchAllowed) return admission;
    let observation: PaymentObservation;
    try {
      observation = await transport(admission);
    } catch {
      await this.markOutcomeUnknown(lease, "transport-outcome-unknown");
      throw new ProtocolError("PAYMENT_OUTCOME_UNKNOWN", "Admitted external outcome is unknown; reconcile the original operation", [admission.operationId]);
    }
    await this.recordObservation(lease, observation);
    return admission;
  }

  async markOutcomeUnknown(scopeInput: Scope & { operationId: string }, reasonInput: unknown): Promise<void> {
    const scope = parseInput(z.strictObject({ workspaceId: identifier, projectId: identifier, operationId: commandIdentifier }), {
      workspaceId: scopeInput.workspaceId, projectId: scopeInput.projectId, operationId: scopeInput.operationId,
    });
    const reason = parseInput(z.enum(["transport-outcome-unknown", "process-recovery"]), reasonInput);
    await this.database.transaction(async (transaction) => {
      await fences(transaction, scope);
      const descriptor = await this.operationDescriptor(transaction, scope, scope.operationId);
      await this.financialLocks(transaction, scope, descriptor.obligation_id);
      await sql`select id from attempts where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${descriptor.attempt_id}::uuid for update`.execute(transaction);
      const operation = first((await sql<Operation>`select * from operations where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId} and id = ${scope.operationId}::uuid for update`.execute(transaction)).rows);
      if (!operation.admitted_at) throw new ProtocolError("RECONCILIATION_REQUIRED", "An unadmitted intent has no external outcome");
      if (operation.state === "result") return;
      await sql`update operations set state = 'unknown' where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${scope.operationId}::uuid`.execute(transaction);
      await sql`update attempts set state = 'unknown' where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${descriptor.attempt_id}::uuid and resolved_at is null`.execute(transaction);
      await history(transaction, scope, "payment-worker", "outcome-unknown", scope.operationId, { reason });
    });
  }

  /** Internal adapter/recovery boundary, not a browser callback or proof of provider authentication. */
  async recordObservation(scopeInput: Scope, input: unknown): Promise<{ matchesBasis: boolean; completed: boolean }> {
    const scope = parseInput(z.strictObject({ workspaceId: identifier, projectId: identifier }), {
      workspaceId: scopeInput.workspaceId, projectId: scopeInput.projectId,
    });
    const observation = parseInput(observationSchema, input);
    if (observation.evidence.kind === "synthetic-fault"
        && (this.options.observationMode !== "local-synthetic-proof" || observation.environment !== "sandbox")) {
      throw new ProtocolError("ACCESS_DENIED", "Synthetic observations require an explicitly configured local sandbox proof store");
    }
    return this.database.transaction(async (transaction) => {
      await fences(transaction, scope);
      const descriptor = await this.operationDescriptor(transaction, scope, observation.operationId);
      const { obligation, unit } = await this.financialLocks(transaction, scope, descriptor.obligation_id);
      const attempt = first((await sql<Attempt>`select * from attempts where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId} and id = ${descriptor.attempt_id}::uuid for update`.execute(transaction)).rows);
      const operation = first((await sql<Operation>`select * from operations where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId} and id = ${observation.operationId}::uuid for update`.execute(transaction)).rows);
      if (!operation.admitted_at) throw new ProtocolError("RECONCILIATION_REQUIRED", "Observation cannot manufacture an unadmitted financial operation");
      const settledConflict = operation.state === "result"
        && financialMeaning(parseInput(observationSchema, operation.result)) !== financialMeaning(observation);
      const matchesBasis = !settledConflict && observation.merchantId === obligation.merchant_id && observation.environment === obligation.environment
        && observation.currency === obligation.currency && observation.gross === obligation.gross
        && (operation.kind === "create"
          ? observation.outcome === "order-created" && !observation.captureId && (!attempt.order_id || attempt.order_id === observation.orderId)
          : attempt.order_id === observation.orderId && observation.outcome !== "order-created"
            && (observation.outcome !== "completed" || Boolean(observation.captureId)));
      const completed = matchesBasis && operation.kind === "capture" && observation.outcome === "completed";
      if (operation.state === "result") {
        if (!settledConflict) {
          const alreadyRecorded = (await sql`select 1 from observations
            where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId}
              and operation_id = ${operation.id}::uuid and payload = ${canonicalJson(observation)}::jsonb limit 1`.execute(transaction)).rows.length !== 0;
          if (!alreadyRecorded) {
            await sql`insert into observations(workspace_id,project_id,id,operation_id,payload,matches_basis)
              values (${scope.workspaceId},${scope.projectId},${randomUUID()}::uuid,${operation.id}::uuid,${canonicalJson(observation)}::jsonb,true)`.execute(transaction);
            await history(transaction, scope, "payment-worker", "payment-observed", operation.id, {
              matchesBasis: true, completed, evidenceKind: observation.evidence.kind, outcome: observation.outcome,
            });
          }
          return { matchesBasis, completed };
        }
        await sql`insert into observations(workspace_id,project_id,id,operation_id,payload,matches_basis)
          values (${scope.workspaceId},${scope.projectId},${randomUUID()}::uuid,${operation.id}::uuid,${canonicalJson(observation)}::jsonb,false)`.execute(transaction);
        await addHold(transaction, scope, "payment-worker", unit.id, "financial", "Contradictory settled-operation evidence requires reconciliation without rewriting the original fact", null);
        await history(transaction, scope, "payment-worker", "payment-observed", operation.id, {
          matchesBasis: false, completed: false, evidenceKind: observation.evidence.kind, outcome: observation.outcome,
        });
        return { matchesBasis: false, completed: false };
      }
      await sql`insert into observations(workspace_id,project_id,id,operation_id,payload,matches_basis)
        values (${scope.workspaceId},${scope.projectId},${randomUUID()}::uuid,${operation.id}::uuid,${canonicalJson(observation)}::jsonb,${matchesBasis})`.execute(transaction);
      if (!matchesBasis) {
        await addHold(transaction, scope, "payment-worker", unit.id, "financial", "Observed financial identity does not match the original admitted basis", null);
        await sql`update operations set state = 'unknown' where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${operation.id}::uuid`.execute(transaction);
        await sql`update attempts set state = 'unknown' where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${attempt.id}::uuid and resolved_at is null`.execute(transaction);
      } else if (operation.kind === "create") {
        await sql`update operations set state = 'result', result = ${canonicalJson(observation)}::jsonb
          where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${operation.id}::uuid`.execute(transaction);
        await sql`update attempts set state = 'order-available', order_id = ${observation.orderId}
          where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${attempt.id}::uuid`.execute(transaction);
      } else if (completed) {
        await sql`insert into payment_facts(workspace_id,project_id,operation_id,capture_id,order_id,merchant_id,environment,currency,gross,evidence)
          values (${scope.workspaceId},${scope.projectId},${operation.id}::uuid,${observation.captureId},${observation.orderId},
            ${observation.merchantId},${observation.environment},${observation.currency},${observation.gross},${canonicalJson(observation.evidence)}::jsonb)`.execute(transaction);
        await sql`update operations set state = 'result', result = ${canonicalJson(observation)}::jsonb
          where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${operation.id}::uuid`.execute(transaction);
        await sql`update attempts set state = 'completed', resolved_at = clock_timestamp() where workspace_id = ${scope.workspaceId}
          and project_id = ${scope.projectId} and id = ${attempt.id}::uuid`.execute(transaction);
      } else {
        const state = observation.outcome === "pending" ? "pending" : "unknown";
        await sql`update operations set state = ${state} where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${operation.id}::uuid`.execute(transaction);
        await sql`update attempts set state = ${state} where workspace_id = ${scope.workspaceId} and project_id = ${scope.projectId} and id = ${attempt.id}::uuid`.execute(transaction);
      }
      await history(transaction, scope, "payment-worker", "payment-observed", operation.id, { matchesBasis, completed, evidenceKind: observation.evidence.kind, outcome: observation.outcome });
      return { matchesBasis, completed };
    });
  }

  async retireCreateOnlyAttempt(payerInput: Payer): Promise<never> {
    const payer = parseInput(payerSchema, payerInput);
    return this.database.transaction(async (transaction) => {
      const project = await fences(transaction, payer);
      await authorizePayer(transaction, payer, project);
      throw new ProtocolError("RETIREMENT_DISABLED", "SP-02 provider and dispatcher closure evidence is required; clocks, cancellation and 404s cannot retire attempts");
    });
  }

  async inspectUnit(actorInput: Actor, unitIdInput: unknown): Promise<{
    unitId: string; acceptedVersion: number | null; currentVersion: number | null;
    holds: Hold[]; readiness: "awaiting-agreement" | "review-hold" | "awaiting-payment" | "awaiting-prerequisite" | "financial-recheck" | "ready";
  }> {
    const actor = parseInput(actorSchema, actorInput);
    const unitId = parseInput(identifier, unitIdInput);
    return this.database.transaction(async (transaction) => {
      const project = await fences(transaction, actor);
      await authorize(transaction, actor, "inspect", project);
      const unit = first(await lockUnits(transaction, actor, [unitId]));
      const holds = await activeHolds(transaction, actor, unitId);
      const result = { unitId, acceptedVersion: unit.accepted_version, currentVersion: unit.current_version, holds };
      if (holds.length) return { ...result, readiness: "review-hold" };
      if (!unit.accepted_version) return { ...result, readiness: "awaiting-agreement" };
      const { snapshot } = await published(transaction, actor, unitId, unit.accepted_version);
      if (snapshot.treatment === "payable") {
        const fact = (await sql<{ fresh: boolean }>`select f.verified_at >= clock_timestamp() - interval '24 hours' as fresh
          from obligations b join attempts a on a.workspace_id = b.workspace_id and a.project_id = b.project_id and a.obligation_id = b.id
          join operations o on o.workspace_id = a.workspace_id and o.project_id = a.project_id and o.attempt_id = a.id and o.kind = 'capture'
          join payment_facts f on f.workspace_id = o.workspace_id and f.project_id = o.project_id and f.operation_id = o.id
          where b.workspace_id = ${actor.workspaceId} and b.project_id = ${actor.projectId} and b.unit_id = ${unitId}
            and b.version = ${unit.accepted_version} and b.collectible`.execute(transaction)).rows[0];
        if (!fact) return { ...result, readiness: "awaiting-payment" };
        if (!fact.fresh) return { ...result, readiness: "financial-recheck" };
      }
      try {
        await checkPrerequisites(transaction, actor, snapshot, "start");
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== "REVIEW_HOLD") throw error;
        return { ...result, readiness: "awaiting-prerequisite" };
      }
      return { ...result, readiness: "ready" };
    });
  }
}

export { ProtocolError };

import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  sql,
  type ProtocolDatabase,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import type {
  LocalClientApproverActivation,
  ParticipantDependencies,
} from "./participant-service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;
const clientId = "cedar-client";
const approverId = "cedar-approver";
const nominationEpoch = 1;
const activationActions = ["inspect", "decide", "correct"] as const;

type ProjectRow = Readonly<{
  display_name: string;
  client_id: string;
  approver_id: string;
  nomination_epoch: number;
  provider_created_by: string | null;
  provider_initial_client_id: string | null;
  provider_initial_approver_id: string | null;
  provider_creation_digest: string | null;
}>;

type ActivationState = Readonly<{
  activation: LocalClientApproverActivation;
  commandId: string;
}>;

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function secret(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.ACCESS_SESSION_SECRET;
  if (!value || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw coded("PARTICIPANT_SECRET_UNAVAILABLE");
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

function confirmationLocator(key: string, project: ProjectRow, projectId: string) {
  return `slpa1_${hmac(
    key,
    "scopeledger.provider-local-client-approver-preview.v1",
    [
      workspaceId,
      projectId,
      project.provider_creation_digest!,
      approverId,
      nominationEpoch,
    ],
  ).toString("base64url")}`;
}

function activationCommandId(key: string, projectId: string): string {
  return derivedUuid(
    key,
    "scopeledger.provider-local-client-approver-command.v1",
    [
      workspaceId,
      projectId,
      providerActorId,
      approverId,
      nominationEpoch,
    ],
  );
}

export function createLocalClientApproverAuthority(input: Readonly<{
  database: ProtocolDatabase;
  secret: string;
}>) {
  if (!/^[a-f0-9]{64}$/iu.test(input.secret)) {
    throw coded("PARTICIPANT_SECRET_UNAVAILABLE");
  }
  async function state(projectId: string): Promise<ActivationState> {
    return input.database.transaction(async (transaction) => {
      const project = (await sql<ProjectRow>`select
          provider_display_name as display_name,
          client_id,approver_id,nomination_epoch,provider_created_by,
          provider_initial_client_id,provider_initial_approver_id,
          provider_creation_digest
        from projects
        where workspace_id = ${workspaceId}
          and id = ${projectId}`
        .execute(transaction)).rows[0];
      if (
        !project
        || !project.provider_creation_digest
        || project.provider_created_by !== providerActorId
        || project.client_id !== clientId
        || project.provider_initial_client_id !== clientId
        || project.provider_initial_approver_id !== approverId
      ) {
        throw coded("NOT_FOUND");
      }
      if (
        project.approver_id !== approverId
        || project.nomination_epoch !== nominationEpoch
      ) {
        throw coded("STALE_CONTEXT");
      }
      const commandId = activationCommandId(input.secret, projectId);
      const receipt = (await sql<{
        recorded_at: Date;
        inspect_epoch: number;
        decide_epoch: number;
        correct_epoch: number;
      }>`select recorded_at,
          (result->'grantEpochs'->>'inspect')::integer as inspect_epoch,
          (result->'grantEpochs'->>'decide')::integer as decide_epoch,
          (result->'grantEpochs'->>'correct')::integer as correct_epoch
        from command_receipts
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and actor_id = ${providerActorId}
          and command_id = ${commandId}::uuid
          and action = 'publish'`
        .execute(transaction)).rows[0];
      const grants = (await sql<{
        action: string;
        epoch: number;
        active: boolean;
      }>`select action,epoch,active from grants
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and actor_id = ${approverId}
        order by action collate "C"`
        .execute(transaction)).rows;
      const exactActiveGrants = grants.length === activationActions.length
        && grants.every((grant) =>
          grant.active
          && activationActions.includes(
            grant.action as typeof activationActions[number],
          )
          && receipt?.[
            `${grant.action}_epoch` as
              | "inspect_epoch"
              | "decide_epoch"
              | "correct_epoch"
          ] === grant.epoch);
      if (
        (receipt && !exactActiveGrants)
        || (!receipt && grants.length !== 0)
      ) {
        throw coded("STALE_CONTEXT");
      }
      return Object.freeze({
        commandId,
        activation: Object.freeze({
          status: receipt ? "active" as const : "ready" as const,
          confirmationLocator: confirmationLocator(
            input.secret,
            project,
            projectId,
          ),
          projectLabel: project.display_name,
          activatedAt: receipt?.recorded_at.toISOString() ?? null,
          authority: Object.freeze({
            inspect: true as const,
            decide: true as const,
            correct: true as const,
            pay: false as const,
          }),
          localChannelVerification: "separate" as const,
          effect: "prospective-project-only" as const,
        }),
      });
    });
  }

  return Object.freeze({
    previewActivation: async (
      request: Readonly<{ projectId: string }>,
    ) => (await state(request.projectId)).activation,
    activate: async (request: Readonly<{
      projectId: string;
      confirmationLocator: string;
    }>) => {
      const before = await state(request.projectId);
      if (!safeEqual(
        before.activation.confirmationLocator,
        request.confirmationLocator,
      )) {
        throw coded("STALE_CONTEXT");
      }
      await new OrderedConsentStore(input.database).activateApproverGrants({
        workspaceId,
        projectId: request.projectId,
        actorId: providerActorId,
        grantEpoch: providerGrantEpoch,
      }, {
        commandId: before.commandId,
        approverId,
        nominationEpoch,
      });
      const after = await state(request.projectId);
      if (after.activation.status !== "active") {
        throw coded("STALE_CONTEXT");
      }
      return Object.freeze({
        activation: after.activation,
        duplicate: before.activation.status === "active",
      });
    },
  });
}

function database(): ProtocolDatabase {
  const current = protocolDatabase();
  if (!current) throw coded("PARTICIPANT_DATABASE_UNAVAILABLE");
  return current;
}

export function providerParticipantDependencies(): ParticipantDependencies {
  const authority = () => createLocalClientApproverAuthority({
    database: database(),
    secret: secret(),
  });
  return Object.freeze({
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    authorize: async ({ projectId, action }) => {
      const result = await sql`select 1 from grants
        where workspace_id = ${workspaceId}
          and project_id = ${projectId}
          and actor_id = ${providerActorId}
          and action = ${action}
          and epoch = ${providerGrantEpoch}
          and active = true
        limit 1`.execute(database().kysely);
      return result.rows.length === 1;
    },
    previewActivation: (input) => authority().previewActivation(input),
    activate: (input) => authority().activate(input),
  });
}

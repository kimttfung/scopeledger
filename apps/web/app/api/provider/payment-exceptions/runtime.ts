import { sql } from "@scopeledger/db";
import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import { refreshPaymentExceptions } from "./refresh";
import type {
  PaymentExceptionDependencies,
  ProviderPaymentException,
} from "./service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;

function database() {
  const current = protocolDatabase();
  if (!current) throw new Error("PAYMENT_EXCEPTION_DATABASE_UNAVAILABLE");
  return current;
}

function title(value: string | null, fallback: string): string {
  if (value) return value;
  return fallback.split("-").filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

type ExceptionRow = {
  sequence: string;
  project_id: string;
  project_name: string | null;
  request_id: string;
  request_title: string | null;
  unit_id: string;
  unit_title: string | null;
  kind: ProviderPaymentException["kind"];
  state: ProviderPaymentException["state"];
  provider_status: string;
  resource_id: string;
  capture_id: string;
  currency: "USD";
  capture_gross: string;
  affected_gross: string | null;
  recorded_at: Date;
  active_financial_hold: boolean;
  work_start_version: number | null;
  work_started_at: Date | null;
};

async function listExceptions(): Promise<readonly ProviderPaymentException[]> {
  const rows = (await sql<ExceptionRow>`select
      h.sequence::text,
      h.project_id,
      p.provider_display_name as project_name,
      packet.id as request_id,
      packet.provider_title as request_title,
      b.unit_id,
      v.snapshot->>'title' as unit_title,
      h.detail->>'kind' as kind,
      h.detail->>'state' as state,
      h.detail->>'providerStatus' as provider_status,
      h.resource_id,
      h.detail->>'captureId' as capture_id,
      h.detail->>'currency' as currency,
      h.detail->>'captureGross' as capture_gross,
      nullif(h.detail->>'affectedGross','') as affected_gross,
      h.recorded_at,
      exists (
        select 1 from holds active_hold
        where active_hold.workspace_id = h.workspace_id
          and active_hold.project_id = h.project_id
          and active_hold.unit_id = b.unit_id
          and active_hold.reason = 'financial'
          and active_hold.resolved_at is null
      ) as active_financial_hold,
      work_start.version as work_start_version,
      work_start.recorded_at as work_started_at
    from protocol_history h
    join operations o
      on o.workspace_id = h.workspace_id
      and o.project_id = h.project_id
      and o.id::text = h.detail->>'operationId'
    join attempts a
      on a.workspace_id = o.workspace_id
      and a.project_id = o.project_id
      and a.id = o.attempt_id
    join obligations b
      on b.workspace_id = a.workspace_id
      and b.project_id = a.project_id
      and b.id = a.obligation_id
    join units u
      on u.workspace_id = b.workspace_id
      and u.project_id = b.project_id
      and u.id = b.unit_id
    join packets packet
      on packet.workspace_id = u.workspace_id
      and packet.project_id = u.project_id
      and packet.id = u.packet_id
    join projects p
      on p.workspace_id = h.workspace_id
      and p.id = h.project_id
    join unit_versions v
      on v.workspace_id = b.workspace_id
      and v.project_id = b.project_id
      and v.unit_id = b.unit_id
      and v.version = b.version
    join grants g
      on g.workspace_id = h.workspace_id
      and g.project_id = h.project_id
      and g.actor_id = ${providerActorId}
      and g.action = 'inspect'
      and g.epoch = ${providerGrantEpoch}
      and g.active = true
    left join lateral (
      select (started.detail->>'version')::integer as version,
        started.recorded_at
      from protocol_history started
      where started.workspace_id = h.workspace_id
        and started.project_id = h.project_id
        and started.event = 'work-started'
        and started.resource_id = b.unit_id
      order by started.sequence
      limit 1
    ) work_start on true
    where h.workspace_id = ${workspaceId}
      and h.event = 'payment-exception-observed'
    order by h.recorded_at desc,h.sequence desc`
    .execute(database().kysely)).rows;
  return Object.freeze(rows.map((row) => Object.freeze({
    observationId: row.sequence,
    projectName: title(row.project_name, row.project_id),
    requestTitle: title(row.request_title, row.request_id),
    unitTitle: row.unit_title ?? title(null, row.unit_id),
    kind: row.kind,
    state: row.state,
    providerStatus: row.provider_status,
    providerResourceId: row.resource_id,
    captureId: row.capture_id,
    currency: row.currency,
    captureGross: row.capture_gross,
    affectedGross: row.affected_gross,
    observedAt: row.recorded_at.toISOString(),
    activeFinancialHold: row.active_financial_hold,
    readiness: row.active_financial_hold
      ? "withheld-financial-exception" as const
      : "no-blocking-effect-observed" as const,
    workStart: row.work_start_version === null || row.work_started_at === null
      ? null
      : {
          version: row.work_start_version,
          recordedAt: row.work_started_at.toISOString(),
        },
  })));
}

async function refresh() {
  const config = payPalConfigFromEnvironment();
  const current = database();
  return refreshPaymentExceptions({
    database: current,
    config,
    provider: new PayPalSandboxClient(config),
    scope: {
      workspaceId,
      providerActorId,
      providerGrantEpoch,
    },
  });
}

export function paymentExceptionDependencies(): PaymentExceptionDependencies {
  return {
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    hasInspectGrant: async () => {
      const result = await sql`select 1 from grants
        where workspace_id = ${workspaceId}
          and actor_id = ${providerActorId}
          and action = 'inspect'
          and epoch = ${providerGrantEpoch}
          and active = true
        limit 1`.execute(database().kysely);
      return result.rows.length === 1;
    },
    listExceptions,
    refresh,
  };
}

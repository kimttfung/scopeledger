import { randomUUID } from "node:crypto";
import {
  ProtocolDatabase,
  sql,
} from "@scopeledger/db";
import {
  OrderedConsentStore,
} from "@scopeledger/domain";

const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
const merchantId = process.env.PAYPAL_MERCHANT_ID;
if (!connectionString || !schema || !merchantId) {
  throw new Error("Database and sandbox merchant configuration are required");
}

const scope = {
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
};
const provider = {
  ...scope,
  actorId: "northstar-provider",
  grantEpoch: 1,
};
const approver = {
  ...scope,
  actorId: "cedar-approver",
  grantEpoch: 1,
};
const contributor = {
  ...scope,
  actorId: "cedar-contributor",
  grantEpoch: 1,
};
const payer = {
  ...scope,
  actorId: "cedar-payer",
  grantEpoch: 1,
};

function command() {
  return { commandId: randomUUID() };
}

function snapshot(version, options) {
  return {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    ...scope,
    clientId: "cedar-client",
    unitId: "unit-u1",
    version,
    contextRevision: 1,
    title: options.title,
    treatment: "payable",
    scope: options.scope,
    exclusions: [
      "No custom photography",
      "No additional pages",
      "No general site redesign",
    ],
    dependencies: [],
    baselineReferences: [{ id: "cedar-baseline", version: 1 }],
    sourceReferences: [{
      id: "cedar-sow",
      version: 1,
      locator: "Synthetic statement of work",
      availability: "available",
    }],
    rationale: options.rationale,
    approver: {
      actorId: approver.actorId,
      nominationEpoch: 1,
      condition: "Named project approver with explicit authority attestation",
    },
    timing: {
      description: "Five working days after approval, full completed payment, and receipt of required content",
      deliveryDependencies: [
        "The included reusable layout precedes final page delivery",
      ],
    },
    prerequisites: [],
    reconciliation: options.reconciliation,
    payment: {
      policy: "full-prepayment",
      financial: {
        currency: "USD",
        merchantId,
        environment: "sandbox",
        lines: options.lines,
        subtotal: options.gross,
        tax: {
          treatment: "none",
          amount: "0.00",
          declaration: "Provider-declared synthetic no tax added",
        },
        gross: options.gross,
      },
    },
    financialEffect: { kind: "new" },
  };
}

const database = new ProtocolDatabase({ connectionString, schema });
try {
  const existing = await sql`select 1 from workspaces where id = ${scope.workspaceId}`.execute(database.kysely);
  if (existing.rows.length > 0) {
    console.log("Cedar Roastery demo state already seeded");
  } else {
    const store = new OrderedConsentStore(database);
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${scope.workspaceId},${merchantId},'sandbox')`.execute(database.kysely);
  await sql`insert into projects(workspace_id,id,client_id,approver_id)
    values (${scope.workspaceId},${scope.projectId},'cedar-client',${approver.actorId})`.execute(database.kysely);
  for (const [actor, actions] of [
    [provider, ["publish", "review", "nominate", "inspect"]],
    [approver, ["decide", "correct", "nominate", "inspect"]],
    [contributor, ["correct", "inspect"]],
    [payer, ["pay", "inspect"]],
  ]) {
    for (const action of actions) {
      await sql`insert into grants(workspace_id,project_id,actor_id,action)
        values (${scope.workspaceId},${scope.projectId},${actor.actorId},${action})`.execute(database.kysely);
    }
  }
  await store.registerContext(provider, {
    ...command(),
    baseline: { id: "cedar-baseline", version: 1 },
    sources: [{
      id: "cedar-sow",
      version: 1,
      availability: "available",
    }],
  });
  await store.createPacket(provider, {
    ...command(),
    packetId: "packet-review",
  });
  await store.createUnit(provider, {
    ...command(),
    packetId: "packet-review",
    unitId: "unit-u1",
  });
  await store.publish(provider, {
    ...command(),
    snapshot: snapshot(1, {
      title: "Reusable layout and one populated case-study page",
      scope: [
        "One reusable case-study layout",
        "One populated case-study page",
      ],
      rationale: "Initial synthetic provider proposal before the client supplied missing context.",
      reconciliation: [],
      lines: [
        {
          id: "layout",
          description: "Reusable case-study layout",
          quantity: "1",
          unitPrice: "150.00",
          amount: "150.00",
        },
        {
          id: "page",
          description: "One populated case-study page",
          quantity: "1",
          unitPrice: "300.00",
          amount: "300.00",
        },
      ],
      gross: "450.00",
    }),
    expectedPreviousVersion: null,
  });
  await store.admitCorrection(contributor, {
    ...command(),
    concernId: "layout-concern",
    packetId: "packet-review",
    originUnitId: "unit-u1",
    scope: { kind: "known", unitIds: ["unit-u1"] },
    claim: {
      statement: "The reusable layout was included in the original agreement.",
      claimedSourceType: "Synthetic accepted email",
      source: {
        availability: "unavailable",
        explanation: "Synthetic fixture records the accepted statement without attaching a private email.",
      },
      sharingAuthorized: true,
      modelProcessingPermitted: false,
    },
  });
  await store.respondToCorrection(provider, {
    ...command(),
    concernId: "layout-concern",
    responseRevision: 1,
    disposition: "accept",
    sourceReview: "Provider reviewed the synthetic agreement and accepted context fixture.",
    explanation: "The reusable layout remains included; only populating one page is additional.",
  });
  await store.publish(provider, {
    ...command(),
    snapshot: snapshot(2, {
      title: "One populated case-study page",
      scope: [
        "One populated case-study page using the included reusable layout",
      ],
      rationale: "Provider reviewed the client context and removed the included layout from the payable unit.",
      reconciliation: [{
        concernId: "layout-concern",
        responseRevision: 1,
      }],
      lines: [{
        id: "page",
        description: "One populated case-study page",
        quantity: "1",
        unitPrice: "300.00",
        amount: "300.00",
      }],
      gross: "300.00",
    }),
    expectedPreviousVersion: 1,
  });
    const state = await store.inspectUnit(provider, "unit-u1");
    console.log(JSON.stringify({
      seeded: true,
      currentVersion: state.currentVersion,
      acceptedVersion: state.acceptedVersion,
      readiness: state.readiness,
      holds: state.holds.map((hold) => hold.reason),
    }, null, 2));
  }
} finally {
  await database.close();
}

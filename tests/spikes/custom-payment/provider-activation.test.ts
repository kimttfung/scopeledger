import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type {
  ApprovedPaymentTarget,
} from "../../../apps/web/app/api/pay/database.js";
import type {
  ReviewLocators,
} from "../../../apps/web/app/api/review/service.js";
import {
  handleProviderPaymentActivatePost,
  handleProviderPaymentPreviewGet,
  PaymentActivationLocatorCodec,
  type ProviderPaymentDependencies,
} from "../../../apps/web/app/api/provider/payments/service.js";

const locators: ReviewLocators = {
  projectLocator: `slr1p_${"A".repeat(43)}`,
  requestLocator: `slr1r_${"B".repeat(43)}`,
  unitLocator: `slr1u_${"C".repeat(43)}`,
};
const baseTarget: ApprovedPaymentTarget = {
  workspaceId: "demo-workspace",
  projectId: "server-project",
  requestId: "server-request",
  unitId: "server-unit",
  version: 1,
  digest: "a".repeat(64),
  obligationId: "server-obligation",
  projectNominationEpoch: 1,
  providerInspectGrantEpoch: 2,
  providerPublishGrantEpoch: 3,
  projectLabel: "Harbor Bakery H1 Demo",
  requestLabel: "Harbor opaque review",
  unitTitle: "Harbor custom payable unit",
  currency: "USD",
  gross: "200.00",
  payer: null,
  activatedAt: null,
};
const codec = new PaymentActivationLocatorCodec("11".repeat(32));

function request(body: unknown): Request {
  return new Request("http://localhost/api/provider/payments/opaque", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function dependencies(
  overrides: Partial<ProviderPaymentDependencies> = {},
  originGuard: (request: Request) => void = (received) => {
    if (received.headers.get("origin") !== "http://localhost") {
      throw new Error("SAME_ORIGIN_REQUIRED");
    }
  },
): ProviderPaymentDependencies {
  let target = baseTarget;
  return {
    requireSameOrigin: originGuard,
    async verifyProvider() {
      return { ok: true };
    },
    async loadTarget() {
      return target;
    },
    confirmationLocator(received) {
      return codec.confirmation(received);
    },
    matchesConfirmation(candidate, received) {
      return codec.matches(candidate, received);
    },
    payerUrl() {
      return [
        "/pay",
        locators.projectLocator,
        locators.requestLocator,
        locators.unitLocator,
        `slr1y_${"D".repeat(43)}`,
      ].join("/");
    },
    async activate(received) {
      target = {
        ...received,
        payer: {
          workspaceId: received.workspaceId,
          projectId: received.projectId,
          actorId: "cedar-payer",
          grantEpoch: 1,
          obligationId: received.obligationId,
          payerEpoch: 1,
          nominationEpoch: received.projectNominationEpoch,
        },
        activatedAt: "2026-11-12T14:00:00.000Z",
      };
      return { duplicate: false };
    },
    ...overrides,
  };
}

async function routeRuntimeModules() {
  const [runtimeModule, routeModule] = await Promise.all([
    import(pathToFileURL(resolve(
      "apps/web/app/api/provider/payments/runtime.ts",
    )).href),
    import(pathToFileURL(resolve(
      "apps/web/app/api/provider/payments/[projectLocator]/[requestLocator]/[unitLocator]/route.ts",
    )).href),
  ]);
  return {
    requireProviderPaymentOrigin:
      runtimeModule.requireProviderPaymentOrigin as (request: Request) => void,
    createProviderPaymentRouteHandlers:
      routeModule.createProviderPaymentRouteHandlers as (
        dependencies: ProviderPaymentDependencies,
      ) => Readonly<{
        GET: (
          request: Request,
          context: Readonly<{ params: Promise<ReviewLocators> }>,
        ) => Promise<Response>;
        POST: (
          request: Request,
          context: Readonly<{ params: Promise<ReviewLocators> }>,
        ) => Promise<Response>;
      }>,
  };
}

function freshRenderedRequest(body: unknown): Request {
  return new Request("http://localhost/api/provider/payments/opaque", {
    method: "POST",
    headers: {
      host: "localhost",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("provider preview is non-mutating and exact to the fixed payer and USD 200 obligation", async () => {
  let activations = 0;
  const response = await handleProviderPaymentPreviewGet(
    locators,
    dependencies({
      async activate() {
        activations += 1;
        return { duplicate: false };
      },
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    activation: {
      amount: { currency: string; gross: string };
      payer: { label: string };
      authority: Record<string, boolean>;
      payerUrl: string | null;
    };
  };
  assert.equal(activations, 0);
  assert.deepEqual(body.activation.amount, {
    currency: "USD",
    gross: "200.00",
  });
  assert.equal(body.activation.payer.label, "Fixed local demo payer");
  assert.deepEqual(body.activation.authority, {
    pay: true,
    inspect: false,
    decide: false,
    correct: false,
    publish: false,
    nominate: false,
  });
  assert.equal(body.activation.payerUrl, null);
});

test("explicit exact confirmation activates only payment authority and emits an opaque URL", async () => {
  const deps = dependencies();
  const response = await handleProviderPaymentActivatePost(
    request({
      confirmationLocator: codec.confirmation(baseTarget),
      confirmed: true,
    }),
    locators,
    deps,
  );
  assert.equal(response.status, 201);
  const body = await response.json() as {
    activation: { status: string; payerUrl: string };
  };
  assert.equal(body.activation.status, "active");
  assert.match(body.activation.payerUrl, /^\/pay\/slr1p_/u);
  const serialized = JSON.stringify(body);
  for (const internal of [
    "demo-workspace",
    "server-project",
    "server-request",
    "server-unit",
    "server-obligation",
    "cedar-payer",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(internal, "u"));
  }
});

test("freshly rendered route activation accepts same-origin fetch metadata when Origin is omitted", async () => {
  const {
    createProviderPaymentRouteHandlers,
    requireProviderPaymentOrigin,
  } = await routeRuntimeModules();
  const deps = dependencies({}, requireProviderPaymentOrigin);
  const route = createProviderPaymentRouteHandlers(deps);
  const context = { params: Promise.resolve(locators) };
  const preview = await route.GET(
    new Request("http://localhost/api/provider/payments/opaque"),
    context,
  );
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as {
    activation: { confirmationLocator: string };
  };
  const activated = await route.POST(
    freshRenderedRequest({
      confirmationLocator: previewBody.activation.confirmationLocator,
      confirmed: true,
    }),
    context,
  );
  assert.equal(activated.status, 201);
  const activatedBody = await activated.json() as {
    ok: boolean;
    activation: { status: string };
  };
  assert.equal(activatedBody.ok, true);
  assert.equal(activatedBody.activation.status, "active");
});

test("approval, email equality, and browser-supplied payment identity cannot activate payer authority", async () => {
  let activated = false;
  const response = await handleProviderPaymentActivatePost(
    request({
      confirmationLocator: codec.confirmation(baseTarget),
      confirmed: true,
      approved: true,
      email: "payer@scopeledger.test",
      role: "payer",
      obligationId: "browser-obligation",
    }),
    locators,
    dependencies({
      async activate() {
        activated = true;
        return { duplicate: false };
      },
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(activated, false);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "INVALID_PAYMENT_AUTHORITY_CONFIRMATION",
  });
});

test("stale confirmation and missing provider assurance fail before activation", async () => {
  let activated = false;
  const stale = await handleProviderPaymentActivatePost(
    request({
      confirmationLocator: `slpc1_${"Z".repeat(43)}`,
      confirmed: true,
    }),
    locators,
    dependencies({
      async activate() {
        activated = true;
        return { duplicate: false };
      },
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(activated, false);

  const denied = await handleProviderPaymentPreviewGet(
    locators,
    dependencies({
      async verifyProvider() {
        return {
          ok: false,
          status: 403,
          code: "PROVIDER_ASSURANCE_REQUIRED",
        };
      },
    }),
  );
  assert.equal(denied.status, 403);
});

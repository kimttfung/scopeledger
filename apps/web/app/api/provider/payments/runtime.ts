import { createHash } from "node:crypto";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  customPaymentActors,
  listProviderPaymentTargets,
  loadProviderPaymentTarget,
  type ApprovedPaymentTarget,
} from "../../pay/database";
import { payerPagePath } from "../../pay/service";
import {
  ReviewLocatorCodec,
  type ReviewLocators,
} from "../../review/service";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  requireSameOrigin,
} from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import {
  PaymentActivationLocatorCodec,
  type ProviderPaymentDependencies,
} from "./service";

function deterministicUuid(parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
  const variant = (
    (Number.parseInt(hex[16]!, 16) & 0x3) | 0x8
  ).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function runtime() {
  const database = protocolDatabase();
  const secret = process.env.ACCESS_SESSION_SECRET;
  if (!database || !secret) {
    throw Object.assign(new Error("Payment authority runtime unavailable"), {
      code: "PAYMENT_AUTHORITY_UNAVAILABLE",
    });
  }
  return {
    database,
    codec: new ReviewLocatorCodec(secret),
    activationCodec: new PaymentActivationLocatorCodec(secret),
    store: new OrderedConsentStore(database),
  };
}

export function requireProviderPaymentOrigin(request: Request): void {
  if (request.headers.get("origin")) {
    requireSameOrigin(request);
    return;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  const fetchMode = request.headers.get("sec-fetch-mode");
  const fetchDestination = request.headers.get("sec-fetch-dest");
  const host = request.headers.get("x-forwarded-host")
    ?? request.headers.get("host");
  if (
    !host
    || fetchSite !== "same-origin"
    || (fetchMode !== "cors" && fetchMode !== "same-origin")
    || (fetchDestination !== null && fetchDestination !== "empty")
  ) {
    throw new Error("SAME_ORIGIN_REQUIRED");
  }
}

function payerLocators(
  codec: ReviewLocatorCodec,
  target: ApprovedPaymentTarget,
  locators: ReviewLocators,
) {
  return Object.freeze({
    ...locators,
    payerLocator: codec.payer(
      target.workspaceId,
      target.projectId,
      target.requestId,
      target.unitId,
      target.version,
      target.digest,
      target.obligationId,
      customPaymentActors.payerActorId,
    ),
  });
}

export function providerPaymentDependencies(): ProviderPaymentDependencies {
  return Object.freeze({
    requireSameOrigin: requireProviderPaymentOrigin,
    verifyProvider: verifiedProvider,
    loadTarget: (locators) => {
      const current = runtime();
      return loadProviderPaymentTarget({
        database: current.database,
        codec: current.codec,
        locators,
      });
    },
    confirmationLocator: (target) =>
      runtime().activationCodec.confirmation(target),
    matchesConfirmation: (candidate, target) =>
      runtime().activationCodec.matches(candidate, target),
    payerUrl: (target, locators) => {
      const current = runtime();
      return payerPagePath(payerLocators(current.codec, target, locators));
    },
    activate: async (target) => {
      const current = runtime();
      await current.store.activatePayerAuthority({
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        actorId: customPaymentActors.providerActorId,
        grantEpoch: target.providerPublishGrantEpoch,
      }, {
        commandId: deterministicUuid([
          "scopeledger.provider-payment-activation.v1",
          target.workspaceId,
          target.projectId,
          target.requestId,
          target.unitId,
          String(target.version),
          target.digest,
          target.obligationId,
          customPaymentActors.payerActorId,
          String(target.projectNominationEpoch),
        ]),
        obligationId: target.obligationId,
        unitId: target.unitId,
        version: target.version,
        digest: target.digest,
        payerId: customPaymentActors.payerActorId,
      });
      return { duplicate: target.payer !== null };
    },
  });
}

export async function listProviderPaymentActivations(): Promise<readonly {
  href: string;
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  currency: "USD";
  gross: string;
  status: "ready" | "active";
}[]> {
  const current = runtime();
  const candidates = await listProviderPaymentTargets({
    database: current.database,
    codec: current.codec,
  });
  return Object.freeze(candidates.map(({ locators, target }) =>
    Object.freeze({
      href: [
        "/provider/payments",
        locators.projectLocator,
        locators.requestLocator,
        locators.unitLocator,
      ].join("/"),
      projectLabel: target.projectLabel,
      requestLabel: target.requestLabel,
      unitTitle: target.unitTitle,
      currency: target.currency,
      gross: target.gross,
      status: target.payer ? "active" as const : "ready" as const,
    })));
}

import {
  PayPalAdapterError,
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import {
  PostgresPayPalWebhookReceiptStore,
} from "@scopeledger/db";
import { protocolDatabase } from "../../../../lib/protocol-database";
import {
  handlePayPalWebhookPost,
  type PayPalWebhookRouteDependencies,
} from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function productionDependencies(): PayPalWebhookRouteDependencies {
  const config = payPalConfigFromEnvironment();
  const client = new PayPalSandboxClient(config);
  const database = protocolDatabase();
  if (!database) {
    throw new PayPalAdapterError(
      "WEBHOOK_STORAGE_FAILED",
      "PostgreSQL webhook storage is unavailable",
    );
  }
  const receipts = new PostgresPayPalWebhookReceiptStore(database);
  return {
    verifyWebhook: (input) => client.verifyWebhook(input),
    insertVerified: (receipt) => receipts.insertVerified({
      workspaceId: "demo-workspace",
      environment: config.environment,
      merchantId: config.merchantId,
      eventId: receipt.eventId,
      eventType: receipt.eventType,
      resourceType: receipt.resourceType,
      resourceId: receipt.resourceId,
      resourceStatus: receipt.resourceStatus,
      providerCreatedAt: receipt.providerCreatedAt,
      receivedAt: receipt.receivedAt,
      verificationReference: `paypal-postback-${receipt.eventId}`,
    }),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePayPalWebhookPost(request, productionDependencies());
  } catch (error) {
    console.error("PayPal webhook rejected before verification", {
      code: error instanceof PayPalAdapterError ? error.code : "UNKNOWN",
    });
    return Response.json(
      { code: "PAYPAL_WEBHOOK_REJECTED" },
      { status: 503 },
    );
  }
}

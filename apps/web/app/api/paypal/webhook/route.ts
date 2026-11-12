import {
  PayPalAdapterError,
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
  persistVerifiedPayPalWebhookReceipt,
} from "@scopeledger/paypal-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_CHARACTERS = 256_000;

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) {
    throw new PayPalAdapterError(
      "WEBHOOK_EVENT_INVALID",
      `Missing required PayPal webhook header: ${name}`,
    );
  }
  return value;
}

function rejectionStatus(error: unknown): number {
  if (!(error instanceof PayPalAdapterError)) return 503;
  if (error.code === "WEBHOOK_EVENT_INVALID") return 400;
  if (error.code === "WEBHOOK_VERIFICATION_FAILED") return 401;
  return 503;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.text();
    if (body.length === 0 || body.length > MAX_WEBHOOK_CHARACTERS) {
      throw new PayPalAdapterError(
        "WEBHOOK_EVENT_INVALID",
        "PayPal webhook body was empty or exceeded the receiver limit",
      );
    }
    let event: unknown;
    try {
      event = JSON.parse(body) as unknown;
    } catch {
      throw new PayPalAdapterError(
        "WEBHOOK_EVENT_INVALID",
        "PayPal webhook body was not valid JSON",
      );
    }

    const client = new PayPalSandboxClient(payPalConfigFromEnvironment());
    await client.verifyWebhook({
      transmissionId: requiredHeader(request, "paypal-transmission-id"),
      transmissionTime: requiredHeader(request, "paypal-transmission-time"),
      transmissionSignature: requiredHeader(request, "paypal-transmission-sig"),
      certificateUrl: requiredHeader(request, "paypal-cert-url"),
      authenticationAlgorithm: requiredHeader(request, "paypal-auth-algo"),
      event,
    });

    const result = await persistVerifiedPayPalWebhookReceipt({
      rootDirectory: process.env.PAYPAL_WEBHOOK_INBOX_DIR
        ?? ".paypal-sandbox/webhooks",
      event,
    });
    return new Response(null, { status: result.duplicate ? 200 : 204 });
  } catch (error) {
    const status = rejectionStatus(error);
    const code = error instanceof PayPalAdapterError ? error.code : "UNKNOWN";
    const providerStatus = error instanceof PayPalAdapterError
      ? error.status
      : undefined;
    const debugId = error instanceof PayPalAdapterError
      ? error.debugId
      : undefined;
    console.error("PayPal webhook rejected", {
      code,
      ...(providerStatus ? { providerStatus } : {}),
      ...(debugId ? { debugId } : {}),
    });
    return Response.json(
      { code: "PAYPAL_WEBHOOK_REJECTED" },
      { status },
    );
  }
}

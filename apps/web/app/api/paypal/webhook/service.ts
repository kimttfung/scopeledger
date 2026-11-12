import {
  PayPalAdapterError,
  normalizeVerifiedPayPalWebhookReceipt,
} from "@scopeledger/paypal-adapter";
import type {
  PayPalWebhookReceipt,
  PayPalWebhookVerificationInput,
} from "@scopeledger/paypal-adapter";

const MAX_WEBHOOK_CHARACTERS = 256_000;

export type PayPalWebhookRouteDependencies = Readonly<{
  verifyWebhook: (
    input: PayPalWebhookVerificationInput,
  ) => Promise<true>;
  insertVerified: (
    receipt: PayPalWebhookReceipt,
  ) => Promise<Readonly<{ duplicate: boolean }>>;
}>;

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

export async function handlePayPalWebhookPost(
  request: Request,
  dependencies: PayPalWebhookRouteDependencies,
): Promise<Response> {
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

    await dependencies.verifyWebhook({
      transmissionId: requiredHeader(request, "paypal-transmission-id"),
      transmissionTime: requiredHeader(request, "paypal-transmission-time"),
      transmissionSignature: requiredHeader(request, "paypal-transmission-sig"),
      certificateUrl: requiredHeader(request, "paypal-cert-url"),
      authenticationAlgorithm: requiredHeader(request, "paypal-auth-algo"),
      event,
    });

    const receipt = normalizeVerifiedPayPalWebhookReceipt({ event });
    const result = await dependencies.insertVerified(receipt);
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

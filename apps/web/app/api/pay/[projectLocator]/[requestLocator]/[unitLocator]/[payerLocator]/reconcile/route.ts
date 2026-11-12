import { customPaymentDependencies } from "../../../../../runtime";
import { handlePaymentReconcilePost } from "../../../../../service";
import type { PaymentLocators } from "../../../../../database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: Readonly<{ params: Promise<PaymentLocators> }>,
): Promise<Response> {
  const dependencies = customPaymentDependencies();
  if (!dependencies) {
    return Response.json(
      { ok: false, code: "PAYMENT_ACCESS_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return handlePaymentReconcilePost(
    request,
    await context.params,
    dependencies,
  );
}

import {
  demoPaymentRuntime,
} from "../runtime";
import {
  handlePaymentPreparePost,
} from "../service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const payment = demoPaymentRuntime({ requireProvider: true });
  if (!payment.ok) {
    return Response.json(
      { ok: false, code: payment.code },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return handlePaymentPreparePost(request, payment.dependencies);
}

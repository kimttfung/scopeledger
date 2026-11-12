import {
  demoPaymentRuntime,
} from "../runtime";
import {
  handlePaymentStatusPost,
} from "../service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const payment = demoPaymentRuntime({ requireProvider: false });
  if (!payment.ok) {
    return Response.json(
      { ok: false, code: payment.code },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return handlePaymentStatusPost(request, payment.dependencies);
}

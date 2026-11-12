import { paymentExceptionDependencies } from "./runtime";
import {
  handlePaymentExceptionsGet,
  handlePaymentExceptionsRefresh,
} from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handlePaymentExceptionsGet(paymentExceptionDependencies());
}

export async function POST(request: Request): Promise<Response> {
  return handlePaymentExceptionsRefresh(
    request,
    paymentExceptionDependencies(),
  );
}

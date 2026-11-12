import { randomUUID } from "node:crypto";
import { AccessError } from "@scopeledger/access";
import { z } from "zod";
import {
  localAccessRuntime,
  requireSameOrigin,
} from "../../../../lib/local-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function status(error: unknown): number {
  if (error instanceof AccessError) {
    if (error.code === "RATE_LIMITED") return 429;
    if (error.code === "INVALID_INPUT") return 422;
  }
  if (error instanceof Error && error.message === "SAME_ORIGIN_REQUIRED") {
    return 403;
  }
  return 503;
}

export async function POST(request: Request): Promise<Response> {
  const runtime = localAccessRuntime();
  if (!runtime) {
    return Response.json(
      { code: "LOCAL_ACCESS_UNAVAILABLE" },
      { status: 503 },
    );
  }
  try {
    requireSameOrigin(request);
    const body = z.strictObject({
      role: z.enum(["client-approver", "payer"]),
    }).parse(await request.json());
    const recipient = body.role === "payer"
      ? runtime.payerRecipient
      : runtime.clientRecipient;
    const challenge = await runtime.store.issue({
      recipient,
      role: body.role,
    });
    try {
      await runtime.email.send({
        kind: "verification-code",
        messageId: randomUUID(),
        recipient,
        code: challenge.code,
        purpose: body.role === "payer"
          ? "payer-access"
          : "client-access",
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      await runtime.store.revoke(challenge.challengeId);
      throw error;
    }
    return Response.json({
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      inboxUrl: runtime.inboxUrl,
    }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { code: "LOCAL_ACCESS_REQUEST_FAILED" },
      {
        status: status(error),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

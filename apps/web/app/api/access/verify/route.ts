import { NextResponse } from "next/server";
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
    if (
      error.code === "CODE_MISMATCH"
      || error.code === "INVALID_INPUT"
    ) return 422;
    if (
      error.code === "EXPIRED"
      || error.code === "SUPERSEDED"
      || error.code === "ATTEMPTS_EXHAUSTED"
      || error.code === "ALREADY_VERIFIED"
    ) return 409;
  }
  if (error instanceof Error && error.message === "SAME_ORIGIN_REQUIRED") {
    return 403;
  }
  return 503;
}

export async function POST(request: Request): Promise<Response> {
  const runtime = localAccessRuntime();
  if (!runtime) {
    return NextResponse.json(
      { code: "LOCAL_ACCESS_UNAVAILABLE" },
      { status: 503 },
    );
  }
  try {
    requireSameOrigin(request);
    const body = z.strictObject({
      challengeId: z.uuid(),
      code: z.string().regex(/^[0-9]{6}$/),
    }).parse(await request.json());
    const session = await runtime.store.verify(body);
    const response = NextResponse.json({
      verified: true,
      role: session.role,
      expiresAt: session.expiresAt,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(
      runtime.cookieName,
      runtime.store.mintSession(session),
      {
        httpOnly: true,
        secure: runtime.cookieSecure,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 60,
      },
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      { code: "LOCAL_ACCESS_VERIFICATION_FAILED" },
      {
        status: status(error),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

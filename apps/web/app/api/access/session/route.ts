import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { localAccessRuntime } from "../../../../lib/local-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const runtime = localAccessRuntime();
  if (!runtime) {
    return NextResponse.json(
      { verified: false, code: "LOCAL_ACCESS_UNAVAILABLE" },
      { status: 503 },
    );
  }
  const token = (await cookies()).get(runtime.cookieName)?.value;
  const session = runtime.store.readSession(token);
  return NextResponse.json(session
    ? {
      verified: true,
      role: session.role,
      expiresAt: session.expiresAt,
    }
    : { verified: false }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(): Promise<Response> {
  const runtime = localAccessRuntime();
  const response = NextResponse.json(
    { verified: false },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (runtime) response.cookies.delete(runtime.cookieName);
  return response;
}

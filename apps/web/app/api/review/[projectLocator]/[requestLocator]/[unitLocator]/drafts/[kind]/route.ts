import {
  handleReviewDraftDelete,
  handleReviewDraftGet,
  handleReviewDraftPut,
} from "../../../../../draft-service";
import { reviewDependencies } from "../../../../../runtime";
import {
  privateReviewHeaders,
  type ReviewLocators,
} from "../../../../../service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = Readonly<{
  params: Promise<ReviewLocators & Readonly<{ kind: string }>>;
}>;

function unavailable(): Response {
  return Response.json({
    ok: false,
    code: "REVIEW_ACCESS_UNAVAILABLE",
  }, {
    status: 503,
    headers: privateReviewHeaders,
  });
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let dependencies;
  try {
    dependencies = reviewDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) return unavailable();
  const { kind, ...locators } = await context.params;
  return handleReviewDraftGet(
    request,
    locators,
    kind,
    dependencies,
  );
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let dependencies;
  try {
    dependencies = reviewDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) return unavailable();
  const { kind, ...locators } = await context.params;
  return handleReviewDraftPut(
    request,
    locators,
    kind,
    dependencies,
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let dependencies;
  try {
    dependencies = reviewDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) return unavailable();
  const { kind, ...locators } = await context.params;
  return handleReviewDraftDelete(
    request,
    locators,
    kind,
    dependencies,
  );
}

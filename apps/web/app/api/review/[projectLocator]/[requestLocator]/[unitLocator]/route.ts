import {
  handleReviewGet,
  privateReviewHeaders,
  type ReviewLocators,
} from "../../../service";
import {
  handleReviewMutationPost,
} from "../../../mutation-service";
import { reviewDependencies } from "../../../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = Readonly<{
  params: Promise<ReviewLocators>;
}>;

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
  if (!dependencies) {
    return Response.json({
      ok: false,
      code: "REVIEW_ACCESS_UNAVAILABLE",
    }, {
      status: 503,
      headers: privateReviewHeaders,
    });
  }
  return handleReviewGet(
    request,
    await context.params,
    dependencies,
  );
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let dependencies;
  try {
    dependencies = reviewDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) {
    return Response.json({
      ok: false,
      code: "REVIEW_ACCESS_UNAVAILABLE",
    }, {
      status: 503,
      headers: privateReviewHeaders,
    });
  }
  return handleReviewMutationPost(
    request,
    await context.params,
    dependencies,
  );
}

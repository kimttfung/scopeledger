import type { ReviewLocators } from "../../../../../review/service";
import {
  handleProviderPaymentActivatePost,
  handleProviderPaymentPreviewGet,
  type ProviderPaymentDependencies,
} from "../../../service";
import { providerPaymentDependencies } from "../../../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<ReviewLocators> }>;

export function createProviderPaymentRouteHandlers(
  dependencies: ProviderPaymentDependencies,
) {
  return Object.freeze({
    GET: async (
      _request: Request,
      context: RouteContext,
    ): Promise<Response> => handleProviderPaymentPreviewGet(
      await context.params,
      dependencies,
    ),
    POST: async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => handleProviderPaymentActivatePost(
      request,
      await context.params,
      dependencies,
    ),
  });
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return createProviderPaymentRouteHandlers(
    providerPaymentDependencies(),
  ).GET(request, context);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return createProviderPaymentRouteHandlers(
    providerPaymentDependencies(),
  ).POST(request, context);
}

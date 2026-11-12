import {
  handleCommercialPublishPost,
} from "../../../../../../../../commercial-service";
import {
  commercialDependencies,
} from "../../../../../../../../commercial-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{
  params: Promise<Readonly<{
    projectId: string;
    requestId: string;
    unitId: string;
  }>>;
}>;

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { projectId, requestId, unitId } = await context.params;
  return handleCommercialPublishPost(
    request,
    projectId,
    requestId,
    unitId,
    commercialDependencies(),
  );
}

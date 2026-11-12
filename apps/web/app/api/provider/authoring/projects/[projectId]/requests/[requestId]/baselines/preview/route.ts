import {
  handleBaselinePreviewPost,
} from "../../../../../../baseline-service";
import {
  baselineDependencies,
} from "../../../../../../baseline-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{
  params: Promise<Readonly<{ projectId: string; requestId: string }>>;
}>;

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { projectId, requestId } = await context.params;
  return handleBaselinePreviewPost(
    request,
    projectId,
    requestId,
    baselineDependencies(),
  );
}

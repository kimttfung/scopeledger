import {
  handleDraftsGet,
  handleDraftsPost,
} from "../../../../../service";
import { authoringDependencies } from "../../../../../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{
  params: Promise<Readonly<{ projectId: string; requestId: string }>>;
}>;

export async function GET(
  _request: Request,
  context: Context,
): Promise<Response> {
  const { projectId, requestId } = await context.params;
  return handleDraftsGet(projectId, requestId, authoringDependencies());
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { projectId, requestId } = await context.params;
  return handleDraftsPost(
    request,
    projectId,
    requestId,
    null,
    authoringDependencies(),
  );
}

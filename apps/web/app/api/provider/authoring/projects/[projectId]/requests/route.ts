import {
  handleRequestsGet,
  handleRequestsPost,
} from "../../../service";
import { authoringDependencies } from "../../../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{
  params: Promise<Readonly<{ projectId: string }>>;
}>;

export async function GET(
  _request: Request,
  context: Context,
): Promise<Response> {
  const { projectId } = await context.params;
  return handleRequestsGet(projectId, authoringDependencies());
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { projectId } = await context.params;
  return handleRequestsPost(request, projectId, authoringDependencies());
}

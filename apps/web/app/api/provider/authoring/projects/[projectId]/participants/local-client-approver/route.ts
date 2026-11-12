import {
  handleParticipantActivatePost,
  handleParticipantPreviewGet,
} from "../../../../participant-service";
import { providerParticipantDependencies } from "../../../../participant-runtime";

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
  return handleParticipantPreviewGet(
    projectId,
    providerParticipantDependencies(),
  );
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { projectId } = await context.params;
  return handleParticipantActivatePost(
    request,
    projectId,
    providerParticipantDependencies(),
  );
}

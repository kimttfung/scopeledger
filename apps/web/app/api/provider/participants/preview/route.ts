import {
  participantLifecycleDependencies,
} from "../runtime";
import { handleParticipantPreviewPost } from "../service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  return handleParticipantPreviewPost(
    request,
    participantLifecycleDependencies(),
  );
}

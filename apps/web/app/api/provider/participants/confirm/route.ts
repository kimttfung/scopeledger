import {
  participantLifecycleDependencies,
} from "../runtime";
import { handleParticipantConfirmPost } from "../service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  return handleParticipantConfirmPost(
    request,
    participantLifecycleDependencies(),
  );
}

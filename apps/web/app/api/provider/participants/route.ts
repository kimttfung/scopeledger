import {
  participantLifecycleDependencies,
} from "./runtime";
import { handleParticipantsGet } from "./service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  return handleParticipantsGet(participantLifecycleDependencies());
}

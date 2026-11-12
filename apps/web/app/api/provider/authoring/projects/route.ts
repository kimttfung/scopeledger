import {
  handleProjectsGet,
  handleProjectsPost,
} from "../service";
import { authoringDependencies } from "../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleProjectsGet(authoringDependencies());
}

export async function POST(request: Request): Promise<Response> {
  return handleProjectsPost(request, authoringDependencies());
}

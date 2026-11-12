import { reconciliationDependencies } from "../../../runtime";
import { handleQuestionResponsePost } from "../../../service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: Readonly<{
    params: Promise<Readonly<{ questionId: string }>>;
  }>,
): Promise<Response> {
  const { questionId } = await context.params;
  return handleQuestionResponsePost(
    request,
    questionId,
    reconciliationDependencies(),
  );
}

import { reconciliationDependencies } from "../../../runtime";
import { handleCorrectionAssessmentPost } from "../../../service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: Readonly<{
    params: Promise<Readonly<{ concernId: string }>>;
  }>,
): Promise<Response> {
  const { concernId } = await context.params;
  return handleCorrectionAssessmentPost(
    request,
    concernId,
    reconciliationDependencies(),
  );
}

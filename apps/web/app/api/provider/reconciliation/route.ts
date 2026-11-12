import { reconciliationDependencies } from "./runtime";
import { handleReconciliationGet } from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleReconciliationGet(reconciliationDependencies());
}

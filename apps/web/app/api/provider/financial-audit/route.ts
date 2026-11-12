import { financialAuditDependencies } from "./runtime";
import {
  handleFinancialAuditGet,
  handleFinancialAuditPost,
} from "./service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleFinancialAuditGet(financialAuditDependencies());
}

export async function POST(request: Request): Promise<Response> {
  return handleFinancialAuditPost(request, financialAuditDependencies());
}

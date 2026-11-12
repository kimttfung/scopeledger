import {
  handleProviderRecordsListGet,
  providerRecordsUnavailableResponse,
} from "./service";
import { providerRecordsDependencies } from "./runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  let dependencies;
  try {
    dependencies = providerRecordsDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) return providerRecordsUnavailableResponse();
  return handleProviderRecordsListGet(request, dependencies);
}

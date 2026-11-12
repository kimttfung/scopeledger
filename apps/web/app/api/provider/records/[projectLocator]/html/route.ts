import {
  handleProviderRecordDownload,
  providerRecordsUnavailableResponse,
} from "../../service";
import { providerRecordsDependencies } from "../../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

type RouteContext = Readonly<{
  params: Promise<Readonly<{ projectLocator: string }>>;
}>;

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let dependencies;
  try {
    dependencies = providerRecordsDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) return providerRecordsUnavailableResponse();
  return handleProviderRecordDownload(
    request,
    (await context.params).projectLocator,
    "html",
    dependencies,
  );
}

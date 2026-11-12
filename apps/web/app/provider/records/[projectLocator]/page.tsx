import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  loadProviderProjectRecord,
} from "../../../api/provider/records/service";
import {
  providerRecordsDependencies,
} from "../../../api/provider/records/runtime";
import {
  ProviderRecordsAccessState,
  ProviderRecordView,
} from "../records-surface";
import styles from "../records.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Protected project history | ScopeLedger",
  description:
    "A private, read-only provider view of one attributed project record.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type PageProps = Readonly<{
  params: Promise<Readonly<{ projectLocator: string }>>;
}>;

const directionContract = `<!--
THESIS: The project record is an inspectable studio specification where chronology, attribution, and missing evidence remain visible together; it refuses a success timeline.
OWN-WORLD: Existing Studio Standards—cool white, ink, cobalt, fine rules, flat fact rows, accessible tables, and print-first hierarchy.
STORY: The provider verifies which facts were recorded, who or what established them, where history is unavailable or redacted, and which capabilities remain unsupported.
FIRST VIEWPORT: Project identity and three explicit export actions sit beside the mandatory disclaimer labels, followed by a compact in-page reading index.
FORM: Established-world attributed history ledger for a precisely bounded extension; no concept seed was required.
-->`;

export default async function ProviderProjectRecordPage({
  params,
}: PageProps) {
  let dependencies;
  try {
    dependencies = providerRecordsDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) {
    return (
      <ProviderRecordsAccessState
        code="RECORDS_UNAVAILABLE"
        styles={styles}
      />
    );
  }

  const { projectLocator } = await params;
  const result = await loadProviderProjectRecord(
    projectLocator,
    dependencies,
  );
  if (!result.ok) {
    if (result.code === "AUTHENTICATION_REQUIRED") {
      redirect(
        `/auth/login?returnTo=/provider/records/${encodeURIComponent(projectLocator)}`,
      );
    }
    return <ProviderRecordsAccessState code={result.code} styles={styles} />;
  }

  return (
    <>
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: directionContract }}
      />
      <ProviderRecordView
        projectLocator={result.project.projectLocator}
        record={result.exported.document}
        styles={styles}
      />
    </>
  );
}

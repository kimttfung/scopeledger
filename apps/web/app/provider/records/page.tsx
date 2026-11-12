import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  listProviderRecordProjects,
} from "../../api/provider/records/service";
import {
  providerRecordsDependencies,
} from "../../api/provider/records/runtime";
import {
  ProviderRecordsAccessState,
  ProviderRecordsIndex,
} from "./records-surface";
import styles from "./records.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Provider project records | ScopeLedger",
  description:
    "Protected project history with private JSON and HTML export.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const directionContract = `<!--
THESIS: Project history is a specification register whose gaps and boundaries carry the same weight as recorded facts; it refuses a metrics dashboard or activity feed.
OWN-WORLD: Existing Studio Standards—cool white, ink, cobalt, fine rules, flat registers, tabular history, and no decorative elevation.
STORY: The verified provider sees only grant-authorized project names, selects one opaque project, then reads, prints, or explicitly downloads its safe attributed record.
FIRST VIEWPORT: A bounded records explanation and read-only boundary lead directly into a ruled project register; no inaccessible totals or internal identifiers appear.
FORM: Established-world specification register for a precisely bounded extension; no concept seed was required.
-->`;

export default async function ProviderRecordsPage() {
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

  const result = await listProviderRecordProjects(dependencies);
  if (!result.ok) {
    if (result.code === "AUTHENTICATION_REQUIRED") {
      redirect("/auth/login?returnTo=/provider/records");
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
      <ProviderRecordsIndex projects={result.projects} styles={styles} />
    </>
  );
}

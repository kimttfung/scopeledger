import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  isReviewPrefetch,
  loadScopedReview,
  type ReviewLocators,
} from "../../../../api/review/service";
import { reviewDependencies } from "../../../../api/review/runtime";
import {
  ReviewAccessState,
  ReviewSurface,
} from "./review-surface";
import styles from "./review.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Protected client review | ScopeLedger",
  description:
    "A scoped view of current published terms with protected client review actions.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const directionContract = `<!--
THESIS: The published unit is a studio specification with its commercial and operational facts in one reading path; it refuses a generic dashboard or checkout funnel.
OWN-WORLD: Existing Studio Standards—cool white, ink, cobalt, fine rules, tabular amounts, flat definition rows, and no decorative elevation.
STORY: The client identifies the scoped project/request/unit, reads exact terms and attributed coverage, then understands current decision, payment, readiness, work-start, and version-history facts.
FIRST VIEWPORT: A compact identity ledger leads to the unit title, treatment, rationale, and an anchored reading index; consequential actions follow the complete record rather than competing with it.
FORM: Established-world extension, specification ledger composition. Preview-first review controls are explicit about what changes and keep payment and work-start unavailable.
-->`;

type PageProps = Readonly<{
  params: Promise<ReviewLocators>;
}>;

export default async function DynamicReviewPage({
  params,
}: PageProps) {
  if (isReviewPrefetch(await headers())) {
    return <ReviewAccessState code="REVIEW_NOT_AVAILABLE" />;
  }

  let dependencies;
  try {
    dependencies = reviewDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) {
    return <ReviewAccessState code="REVIEW_ACCESS_UNAVAILABLE" />;
  }

  const result = await loadScopedReview(await params, dependencies);
  return (
    <>
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: directionContract }}
      />
      {result.ok
        ? <ReviewSurface review={result.review} styles={styles} />
        : <ReviewAccessState code={result.code} />}
    </>
  );
}

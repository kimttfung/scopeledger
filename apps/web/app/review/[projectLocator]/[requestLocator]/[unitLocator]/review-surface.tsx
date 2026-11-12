import React from "react";
import Link from "next/link";
import type {
  ReviewLoadFailureCode,
  ReviewProjection,
} from "../../../../api/review/service";
import { ReviewActions } from "./review-actions";

export type ReviewStyles = Readonly<Record<string, string>>;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function formatMoney(value: string): string {
  return moneyFormatter.format(Number(value));
}

function treatmentLabel(
  treatment: ReviewProjection["unit"]["treatment"],
): string {
  return treatment === "payable"
    ? "Additional payable work"
    : "Additional work · payment waived";
}

function readinessLabel(
  readiness: ReviewProjection["facts"]["readiness"],
): string {
  const labels = {
    "awaiting-agreement": "Awaiting agreement",
    "review-hold": "Review hold",
    "awaiting-payment": "Awaiting payment",
    "awaiting-prerequisite": "Awaiting prerequisite",
    "financial-recheck": "Financial recheck required",
    ready: "Ready for additional work",
  } as const;
  return labels[readiness];
}

function decisionLabel(
  decision: ReviewProjection["facts"]["decision"]["status"],
): string {
  const labels = {
    "not-recorded": "No decision recorded",
    approved: "Approved",
    declined: "Declined",
  } as const;
  return labels[decision];
}

function paymentLabel(
  payment: ReviewProjection["facts"]["payment"]["status"],
): string {
  const labels = {
    "not-required": "Payment not required",
    "not-authorized": "Not authorized by an approval",
    "not-initiated": "Not initiated",
    "in-progress": "Checkout in progress",
    processing: "Provider processing",
    "outcome-unknown": "Outcome unknown · reconciliation required",
    verified: "Payment verified",
  } as const;
  return labels[payment];
}

function holdLabel(reason: string): string {
  const labels: Record<string, string> = {
    correction: "Context correction",
    impact: "Related-unit impact",
    source: "Source review",
    stop: "Stop instruction",
    financial: "Financial review",
    restore: "Restore review",
  };
  return labels[reason] ?? "Review hold";
}

function DefinitionRow({
  label,
  children,
}: Readonly<{
  label: string;
  children: React.ReactNode;
}>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ReviewAccessState({
  code,
}: Readonly<{ code: ReviewLoadFailureCode }>) {
  const content = {
    CLIENT_ACCESS_REQUIRED: {
      title: "Verify client access",
      status: "A verified local client-approver session is required.",
      detail:
        "Open the local access flow, verify the client-approver channel, then return to the same scoped review address.",
      action: true,
    },
    CLIENT_APPROVER_REQUIRED: {
      title: "Client approver access required",
      status: "This verified session has a different role.",
      detail:
        "Sign out of local access and verify the current client-approver channel. Payer access cannot open client review terms.",
      action: true,
    },
    REVIEW_NOT_AUTHORIZED: {
      title: "Review access changed",
      status: "This session no longer matches the current project approver.",
      detail:
        "The current server-owned project assignment or grant does not accept this session. Reverify only after the project owner confirms access.",
      action: true,
    },
    REVIEW_STATE_CHANGED: {
      title: "Published review unavailable",
      status: "The current published record could not be verified.",
      detail:
        "No terms are shown from a stale or malformed snapshot. Ask the provider for a fresh scoped review address.",
      action: false,
    },
    REVIEW_NOT_AVAILABLE: {
      title: "Review not available",
      status: "This scoped review address is unknown or no longer current.",
      detail:
        "Check the complete address from the provider. Project, request, and unit locators cannot be mixed across reviews.",
      action: false,
    },
    REVIEW_ACCESS_UNAVAILABLE: {
      title: "Review temporarily unavailable",
      status: "Protected review access could not be checked.",
      detail:
        "Try again after the local access and protocol database services are available.",
      action: false,
    },
  }[code];

  return (
    <>
      <a className="skip-link" href="#review-status">
        Skip to review status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/" prefetch={false}>
            ScopeLedger<span className="wordmark-dot" aria-hidden="true">.</span>
          </Link>
          <span className="studio-name">Client review</span>
          <span className="prototype-label">Protected read-only view</span>
        </div>
      </header>
      <main className="payment-return-shell" id="review-status">
        <section
          className="payment-return-panel"
          aria-labelledby="review-status-title"
        >
          <h1 id="review-status-title">{content.title}</h1>
          <div className="payment-return-status" role="status">
            <strong>{content.status}</strong>
            <p>{content.detail}</p>
          </div>
          {content.action && (
            <div className="payment-return-actions">
              <Link className="button" href="/access-demo" prefetch={false}>
                Open local access
              </Link>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

export function ReviewSurface({
  review,
  styles,
}: Readonly<{
  review: ReviewProjection;
  styles: ReviewStyles;
}>) {
  const priorVersions = review.history.previousVersions;
  return (
    <>
      <a className="skip-link" href="#review-main">Skip to review</a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/" prefetch={false}>
            ScopeLedger<span className="wordmark-dot" aria-hidden="true">.</span>
          </Link>
          <span className="studio-name">Client review</span>
          <span className="prototype-label">Protected review</span>
          <span className="role-label">Client approver</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          This page reads the current published record. A verified client
          approver can preview and record a decision, question, or correction.
          Payment remains a separate fixed-payer flow, and work start remains
          unavailable here.
        </p>
      </div>

      <main className={styles.main} id="review-main">
        <header className={styles.reviewHeader}>
          <dl className={styles.identityGrid} aria-label="Review identity">
            <DefinitionRow label="Project">{review.project.label}</DefinitionRow>
            <DefinitionRow label="Request">{review.request.label}</DefinitionRow>
            <DefinitionRow label="Unit">{review.unit.title}</DefinitionRow>
            <DefinitionRow label="Version">Version {review.unit.version}</DefinitionRow>
          </dl>
          <div className={styles.titleBlock}>
            <div>
              <h1>{review.unit.title}</h1>
              <p>
                Published {formatDate(review.unit.publishedAt)} · Version{" "}
                {review.unit.version}
              </p>
            </div>
            <span className={styles.treatment}>
              {treatmentLabel(review.unit.treatment)}
            </span>
          </div>
          <p className={styles.rationale}>{review.unit.rationale}</p>
        </header>

        <nav className={styles.sectionNav} aria-label="Review sections">
          <a href="#scope">Scope and terms</a>
          <a href="#attribution">Source coverage</a>
          <a href="#facts">Current facts</a>
          <a href="#actions">Your response</a>
          <a href="#history">Version history</a>
        </nav>

        <section className={styles.section} id="scope">
          <h2>Scope and exact terms</h2>
          <div className={styles.scopeColumns}>
            <div>
              <h3>Included in this unit</h3>
              <ul>
                {review.unit.scope.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Excluded from this unit</h3>
              {review.unit.exclusions.length > 0
                ? (
                  <ul>
                    {review.unit.exclusions.map((item, index) => (
                      <li key={`${index}-${item}`}>{item}</li>
                    ))}
                  </ul>
                )
                : <p>No exclusions are recorded for this version.</p>}
            </div>
          </div>

          <div className={styles.detailBlock}>
            <h3>Provider rationale</h3>
            <p>{review.unit.rationale}</p>
          </div>

          {review.commercial.kind === "payable"
            ? (
              <div className={styles.commercial}>
                <h3>Price, tax, and payment condition</h3>
                <div className={styles.tableWrap}>
                  <table>
                    <caption className="sr-only">
                      Exact published price lines
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Item</th>
                        <th scope="col">Quantity</th>
                        <th scope="col">Unit price</th>
                        <th scope="col">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.commercial.lines.map((line, index) => (
                        <tr key={`${line.description}-${index}`}>
                          <th scope="row">{line.description}</th>
                          <td>{line.quantity}</td>
                          <td>{formatMoney(line.unitPrice)}</td>
                          <td>{formatMoney(line.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={3}>Subtotal</th>
                        <td>{formatMoney(review.commercial.subtotal)}</td>
                      </tr>
                      <tr>
                        <th scope="row" colSpan={3}>
                          Tax · {review.commercial.tax.treatment}
                        </th>
                        <td>{formatMoney(review.commercial.tax.amount)}</td>
                      </tr>
                      <tr>
                        <th scope="row" colSpan={3}>Total</th>
                        <td>{formatMoney(review.commercial.gross)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <dl className={styles.terms}>
                  <DefinitionRow label="Tax declaration">
                    {review.commercial.tax.declaration}
                  </DefinitionRow>
                  <DefinitionRow label="Payment condition">
                    Full prepayment after approval of this exact published
                    version. Approval and payment remain separate facts.
                  </DefinitionRow>
                  <DefinitionRow label="Timing">
                    {review.unit.timing.description}
                  </DefinitionRow>
                </dl>
              </div>
            )
            : (
              <div className={styles.commercial}>
                <h3>Payment condition</h3>
                <p>
                  No payment is required for this published unit.{" "}
                  {review.commercial.explanation}
                </p>
                <dl className={styles.terms}>
                  <DefinitionRow label="Timing">
                    {review.unit.timing.description}
                  </DefinitionRow>
                </dl>
              </div>
            )}

          {(review.unit.timing.deliveryDependencies.length > 0
            || review.unit.dependencies.length > 0
            || review.unit.prerequisites.length > 0) && (
            <div className={styles.conditions}>
              <h3>Delivery and prerequisite conditions</h3>
              <ul>
                {review.unit.timing.deliveryDependencies.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
                {review.unit.dependencies.map((item, index) => (
                  <li key={`${item.explanation}-${index}`}>
                    Unit dependency: {item.explanation}
                  </li>
                ))}
                {review.unit.prerequisites.map((item, index) => (
                  <li key={`${item.description}-${index}`}>
                    {item.description} · blocks {item.blocks.replaceAll("-", " ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className={styles.approverCondition}>
            Approval condition: {review.unit.approverCondition}
          </p>
        </section>

        <section className={styles.section} id="attribution">
          <h2>Source and coverage attribution</h2>
          <p className={styles.sectionIntro}>
            References are identified by their place in the published basis.
            Private storage locations, provider notes, and internal identifiers
            are not displayed.
          </p>
          <div className={styles.attributionGrid}>
            <div>
              <h3>Published sources</h3>
              <ul className={styles.recordList}>
                {review.attribution.sources.map((source) => (
                  <li key={`${source.label}-${source.version}`}>
                    <strong>{source.label} · version {source.version}</strong>
                    <span>
                      {source.origin ? `${source.origin} · ` : ""}
                      {source.availability}
                    </span>
                    <span>{source.coverage}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Confirmed baselines</h3>
              <ul className={styles.recordList}>
                {review.attribution.baselines.map((baseline) => (
                  <li key={`${baseline.label}-${baseline.version}`}>
                    <strong>
                      {baseline.label} · version {baseline.version}
                    </strong>
                    <span>{baseline.coverage}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className={styles.section} id="facts">
          <h2>Current recorded facts</h2>
          <div className={styles.factGrid}>
            <div>
              <span>Decision</span>
              <strong>{decisionLabel(review.facts.decision.status)}</strong>
              <small>
                Current version {review.facts.decision.version}
                {review.facts.decision.recordedAt
                  ? ` · ${formatDate(review.facts.decision.recordedAt)}`
                  : ""}
              </small>
            </div>
            <div>
              <span>Payment</span>
              <strong>{paymentLabel(review.facts.payment.status)}</strong>
              <small>
                {review.facts.payment.verifiedAt
                  ? `Verified ${formatDate(review.facts.payment.verifiedAt)}`
                  : "No provider payment identifiers are shown."}
              </small>
            </div>
            <div>
              <span>Readiness</span>
              <strong>{readinessLabel(review.facts.readiness)}</strong>
              <small>
                {review.facts.acceptedVersion
                  ? `Derived from accepted version ${review.facts.acceptedVersion}.`
                  : "No accepted version is recorded."}
              </small>
            </div>
            <div>
              <span>Actual work start</span>
              <strong>
                {review.facts.workStart.recorded
                  ? "Recorded"
                  : "Not recorded"}
              </strong>
              <small>
                {review.facts.workStart.recordedAt
                  ? `Version ${review.facts.workStart.version} · ${formatDate(review.facts.workStart.recordedAt)}`
                  : "Readiness does not prove that work began."}
              </small>
            </div>
          </div>
          {review.facts.holds.length > 0
            ? (
              <div className={styles.holds} role="status">
                <strong>Active review holds</strong>
                <ul>
                  {review.facts.holds.map((hold, index) => (
                    <li key={`${hold.reason}-${index}`}>
                      {holdLabel(hold.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )
            : <p className={styles.noHolds}>No active review holds.</p>}
        </section>

        <ReviewActions review={review} styles={styles} />

        <section className={styles.section} id="history">
          <h2>Historical-version disclosure</h2>
          {review.history.previousVersionCount === 0
            ? (
              <p>
                This is the first published version of the unit. Viewing it
                does not create a decision or change any other fact.
              </p>
            )
            : (
              <>
                <p>
                  {review.history.previousVersionCount} earlier published{" "}
                  {review.history.previousVersionCount === 1
                    ? "version remains"
                    : "versions remain"} in the record. Earlier versions are
                  historical and are not rewritten by this current review.
                </p>
                <ol className={styles.historyList}>
                  {priorVersions.map((version) => (
                    <li key={version.version}>
                      Version {version.version} · published{" "}
                      {formatDate(version.publishedAt)}
                    </li>
                  ))}
                </ol>
                {review.history.additionalPreviousVersions > 0 && (
                  <p className={styles.historyRemainder}>
                    {review.history.additionalPreviousVersions} additional
                    historical versions are retained but not expanded here.
                  </p>
                )}
              </>
            )}
        </section>

        <aside className={styles.readOnlyBoundary} aria-labelledby="boundary-title">
          <div>
            <h2 id="boundary-title">Remaining boundary</h2>
            <p>
              Review mutations are available only for the server-current
              published unit. Financial and operational mutations are outside
              this page.
            </p>
          </div>
          <ul>
            <li>Start or reconcile payment · unavailable</li>
            <li>Record work start · unavailable</li>
            <li>Change provider publication · unavailable</li>
          </ul>
        </aside>
      </main>
    </>
  );
}

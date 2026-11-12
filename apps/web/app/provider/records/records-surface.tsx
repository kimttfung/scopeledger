import React from "react";
import Link from "next/link";
import type { RecordExportV1 } from "@scopeledger/records-export";
import type {
  ProviderRecordProject,
  ProviderRecordsFailureCode,
} from "../../api/provider/records/service";
import PrintRecordButton from "./print-record-button";

const factGroups = [
  ["requests", "Requests"],
  ["sources", "Sources"],
  ["drafts", "Draft revisions"],
  ["publications", "Published terms"],
  ["corrections", "Client corrections"],
  ["questions", "Client questions"],
  ["agreements", "Agreement decisions"],
  ["obligations", "Payment obligations"],
  ["payments", "Payment facts"],
  ["readiness", "Readiness checks"],
  ["workStarts", "Actual work starts"],
  ["analysisCandidates", "Analysis candidates"],
  ["analysisReviews", "Provider analysis reviews"],
] as const satisfies readonly (
  readonly [keyof RecordExportV1["facts"], string]
)[];

export type ProviderRecordsStyles = Readonly<Record<string, string>>;

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function Instant({
  value,
  styles,
}: {
  value: string | null;
  styles: ProviderRecordsStyles;
}) {
  if (value === null) return <span className={styles.quiet}>Unavailable</span>;
  return <time dateTime={value}>{timestamp(value)} UTC</time>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function RecordValue({
  value,
  styles,
  field = "",
}: {
  value: unknown;
  styles: ProviderRecordsStyles;
  field?: string;
}): React.ReactNode {
  if (value === null) return <span className={styles.quiet}>Not recorded</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/At$/u.test(field) && Number.isFinite(new Date(value).getTime())) {
      return <Instant value={value} styles={styles} />;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className={styles.quiet}>None recorded</span>;
    }
    return (
      <ul className={styles.valueList}>
        {value.map((item, index) => (
          <li key={`${field}-${index}`}>
            <RecordValue value={item} styles={styles} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([name]) =>
        !["recordRef", "occurredAt", "attribution"].includes(name));
    if (entries.length === 0) {
      return <span className={styles.quiet}>No additional fields</span>;
    }
    return (
      <dl className={styles.fields}>
        {entries.map(([name, child]) => (
          <div key={name}>
            <dt>{humanize(name)}</dt>
            <dd>
              <RecordValue value={child} field={name} styles={styles} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className={styles.quiet}>Unsupported value</span>;
}

function SurfaceHeader({
  label,
  styles,
  roleLabel = "Verified provider",
}: {
  label: string;
  styles: ProviderRecordsStyles;
  roleLabel?: string;
}) {
  return (
    <>
      <a className="skip-link" href="#provider-records-main">
        Skip to provider project records
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">{label}</span>
          <span className="role-label">{roleLabel}</span>
        </div>
      </header>
      <div className={`prototype-notice ${styles.screenOnly}`}>
        <p>
          Verified identity opens this surface. Every list, view, and download
          rechecks the synthetic provider&apos;s current server-side grant.
        </p>
        <Link href="/provider">Provider access</Link>
      </div>
    </>
  );
}

function accessCopy(code: ProviderRecordsFailureCode): Readonly<{
  title: string;
  status: string;
  detail: string;
}> {
  switch (code) {
    case "PROVIDER_ASSURANCE_REQUIRED":
      return {
        title: "Additional verification required",
        status: "Verified email and MFA assurance are required",
        detail:
          "Authentication alone does not grant access to provider project records.",
      };
    case "PROVIDER_GRANT_REQUIRED":
      return {
        title: "Project records are not authorized",
        status: "The provider product grant is not active",
        detail:
          "The current server-side grant does not permit this records operation.",
      };
    case "RECORD_NOT_AVAILABLE":
      return {
        title: "Project record not available",
        status: "The opaque project selection is unavailable",
        detail:
          "Return to the records register and choose a project currently authorized for this provider.",
      };
    case "RECORD_EXPORT_STATE_CHANGED":
      return {
        title: "Project record changed",
        status: "A safe export could not be assembled",
        detail:
          "Refresh after the project history is complete and internally consistent.",
      };
    case "RECORD_EXPORT_TOO_LARGE":
      return {
        title: "Project record exceeds this export profile",
        status: "No partial export was produced",
        detail:
          "The bounded exporter stopped rather than truncating project history.",
      };
    case "AUTHENTICATION_REQUIRED":
      return {
        title: "Provider sign-in required",
        status: "No provider session is available",
        detail: "Sign in with the protected provider account before continuing.",
      };
    default:
      return {
        title: "Project records are temporarily unavailable",
        status: "Protected records could not be read",
        detail: "Try again after the records service is available.",
      };
  }
}

export function ProviderRecordsAccessState({
  code,
  styles,
}: {
  code: ProviderRecordsFailureCode;
  styles: ProviderRecordsStyles;
}) {
  const copy = accessCopy(code);
  return (
    <>
      <SurfaceHeader
        label="Protected records"
        roleLabel="Provider access"
        styles={styles}
      />
      <main
        className="payment-return-shell"
        id="provider-records-main"
      >
        <section
          className="payment-return-panel"
          aria-labelledby="records-access-title"
        >
          <h1 id="records-access-title">{copy.title}</h1>
          <div className="payment-return-status" role="status">
            <strong>{copy.status}</strong>
            <p>{copy.detail}</p>
          </div>
          <div className="payment-return-actions">
            <Link className="button" href="/provider">
              Return to provider access
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}

export function ProviderRecordsIndex({
  projects,
  styles,
}: {
  projects: readonly ProviderRecordProject[];
  styles: ProviderRecordsStyles;
}) {
  return (
    <>
      <SurfaceHeader label="Project records" styles={styles} />
      <main className={styles.main} id="provider-records-main">
        <section className={styles.intro} aria-labelledby="records-title">
          <div>
            <h1 id="records-title">Provider project records</h1>
            <p>
              Select an authorized project to read its attributed history,
              inspect known gaps, print the record, or download a standalone
              JSON or HTML export.
            </p>
          </div>
          <aside className={styles.boundary}>
            <strong>Read-only record</strong>
            This surface does not send, email, publish, change consent, move
            money, or record delivery.
          </aside>
        </section>

        <section
          className={styles.register}
          aria-labelledby="project-register-title"
        >
          <div className={styles.sectionTitle}>
            <h2 id="project-register-title">Projects available to this grant</h2>
            <p>
              Project selectors are opaque. Internal resource and actor
              identities are not shown.
            </p>
          </div>
          {projects.length === 0 ? (
            <p className={styles.empty}>
              No project record is available to the current provider grant.
            </p>
          ) : (
            <ul className={styles.projectList}>
              {projects.map((project) => (
                <li key={project.projectLocator}>
                  <div>
                    <strong>{project.displayName}</strong>
                    <span>Attributed history and known export gaps</span>
                  </div>
                  <a
                    className={styles.projectLink}
                    href={`/provider/records/${project.projectLocator}`}
                  >
                    View project record
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className={styles.notices} aria-labelledby="records-labels">
          <h2 id="records-labels">Record boundaries</h2>
          <ul>
            <li>This record is not a legal opinion.</li>
            <li>This record is not a delivery receipt.</li>
            <li>This record is not a dispute submission.</li>
            <li>This record is not proof of satisfactory delivery.</li>
          </ul>
        </aside>
      </main>
    </>
  );
}

function FactSection({
  name,
  title,
  facts,
  styles,
}: {
  name: string;
  title: string;
  facts: readonly unknown[];
  styles: ProviderRecordsStyles;
}) {
  const id = `record-facts-${name}`;
  return (
    <section className={styles.recordSection} aria-labelledby={id}>
      <div className={styles.sectionBand}>
        <h2 id={id}>{title}</h2>
      </div>
      {facts.length === 0 ? (
        <p className={styles.emptyFact}>No supported facts recorded.</p>
      ) : (
        <ol className={styles.factList}>
          {facts.map((fact, index) => {
            const record = isRecord(fact) ? fact : {};
            const recordRef = typeof record.recordRef === "string"
              ? record.recordRef
              : `record-${index + 1}`;
            const occurredAt = typeof record.occurredAt === "string"
              ? record.occurredAt
              : null;
            const attribution = typeof record.attribution === "string"
              ? record.attribution
              : "Attribution unavailable";
            return (
              <li key={recordRef}>
                <article className={styles.fact}>
                  <header className={styles.factHeader}>
                    <code>{recordRef}</code>
                    <span>{humanize(attribution)}</span>
                    <Instant value={occurredAt} styles={styles} />
                  </header>
                  <RecordValue value={record} styles={styles} />
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function ProviderRecordView({
  projectLocator,
  record,
  styles,
}: {
  projectLocator: string;
  record: RecordExportV1;
  styles: ProviderRecordsStyles;
}) {
  return (
    <>
      <SurfaceHeader label="Project history" styles={styles} />
      <main className={styles.main} id="provider-records-main">
        <section className={styles.recordIntro} aria-labelledby="record-title">
          <div>
            <Link
              className={styles.backLink}
              href="/provider/records"
              prefetch={false}
            >
              Return to project records
            </Link>
            <h1 id="record-title">{record.project.displayName}</h1>
            <dl className={styles.identity}>
              <div>
                <dt>Record reference</dt>
                <dd><code>{record.project.recordRef}</code></dd>
              </div>
              <div>
                <dt>Project created</dt>
                <dd>
                  <Instant value={record.project.createdAt} styles={styles} />
                </dd>
              </div>
              <div>
                <dt>Attribution</dt>
                <dd>{humanize(record.project.attribution)}</dd>
              </div>
            </dl>
          </div>
          <div className={`${styles.actions} ${styles.screenOnly}`}>
            <a
              className={`button ${styles.action}`}
              href={`/api/provider/records/${projectLocator}/json`}
              download
            >
              Download JSON
            </a>
            <a
              className={`button ${styles.action}`}
              href={`/api/provider/records/${projectLocator}/html`}
              download
            >
              Download HTML
            </a>
            <PrintRecordButton className={`button ${styles.action}`} />
          </div>
        </section>

        <aside className={styles.notices} aria-labelledby="export-labels">
          <h2 id="export-labels">Important export labels</h2>
          <ul>
            {record.labels.notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </aside>

        <nav className={styles.recordNav} aria-label="Project record sections">
          <a href="#record-history">Chronological history</a>
          <a href="#record-facts">Attributed facts</a>
          <a href="#record-gaps">Known gaps</a>
          <a href="#record-boundaries">Capability boundaries</a>
        </nav>

        <section
          className={styles.recordSection}
          id="record-history"
          aria-labelledby="record-history-title"
        >
          <div className={styles.sectionBand}>
            <h2 id="record-history-title">Chronological history</h2>
          </div>
          {record.timeline.length === 0 ? (
            <p className={styles.emptyFact}>
              No timestamped facts recorded.
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table>
                <caption>Chronological attributed facts</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Attribution</th>
                    <th scope="col">Summary</th>
                    <th scope="col">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {record.timeline.map((item) => (
                    <tr key={`${item.recordRef}-${item.kind}-${item.occurredAt}`}>
                      <td>
                        <Instant value={item.occurredAt} styles={styles} />
                      </td>
                      <td>{humanize(item.kind)}</td>
                      <td>{humanize(item.attribution)}</td>
                      <td>{item.summary}</td>
                      <td><code>{item.recordRef}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div id="record-facts">
          {factGroups.map(([name, title]) => (
            <FactSection
              key={name}
              name={name}
              title={title}
              facts={record.facts[name]}
              styles={styles}
            />
          ))}
        </div>

        <section
          className={styles.recordSection}
          id="record-gaps"
          aria-labelledby="record-gaps-title"
        >
          <div className={styles.sectionBand}>
            <h2 id="record-gaps-title">
              Unavailable, redacted, and unsupported gaps
            </h2>
          </div>
          {record.gaps.length === 0 ? (
            <p className={styles.emptyFact}>No gaps recorded.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table>
                <caption>Known export gaps</caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {record.gaps.map((gap) => (
                    <tr key={`${gap.recordRef}-${gap.category}-${gap.status}`}>
                      <td>{humanize(gap.category)}</td>
                      <td>{humanize(gap.status)}</td>
                      <td>{gap.reason}</td>
                      <td><code>{gap.recordRef}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section
          className={styles.boundarySection}
          id="record-boundaries"
          aria-labelledby="record-boundaries-title"
        >
          <h2 id="record-boundaries-title">Capability boundaries</h2>
          <dl>
            <div>
              <dt>Delivery facts</dt>
              <dd>{humanize(record.capabilities.delivery)}</dd>
            </div>
            <div>
              <dt>Delivery acceptance facts</dt>
              <dd>{humanize(record.capabilities.deliveryAcceptance)}</dd>
            </div>
          </dl>
        </section>
      </main>
    </>
  );
}

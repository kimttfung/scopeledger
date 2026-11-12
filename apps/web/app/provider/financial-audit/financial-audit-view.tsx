import React from "react";
import type {
  ProviderFinancialAuditRun,
  ProviderFinancialAuditStatus,
} from "../../api/provider/financial-audit/service";

function stamp(value: string | null): string {
  if (!value) return "No verified receipt recorded";
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "No receipt queue";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor(
    (seconds % 3_600) / 60,
  )}m`;
}

function healthLabel(status: ProviderFinancialAuditStatus): string {
  if (status.credentialFailures > 0) return "Provider credentials unavailable";
  if (status.staleFacts > 0) return "Financial recheck required";
  if (status.activeAttempts > 0) return "Active capture reconciliation";
  return "No stale known fact";
}

export function FinancialAuditView({
  status,
  run,
  busy,
  message,
  error,
  onAudit,
  styles,
}: {
  status: ProviderFinancialAuditStatus | null;
  run: ProviderFinancialAuditRun | null;
  busy: boolean;
  message: string | null;
  error: string | null;
  onAudit: () => void;
  styles: Readonly<Record<string, string>>;
}) {
  if (!status && !error) {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-label="Loading financial audit health"
      >
        <span />
        <span />
        <span />
      </div>
    );
  }

  return (
    <section className={styles.workspace} aria-labelledby="health-heading">
      <div className={styles.toolbar}>
        <div>
          <h2 id="health-heading">Operational health</h2>
          <p>
            The scheduled CLI audits every known target in deterministic
            bounded pages. This manual trigger audits the next 50 targets and
            receipts for immediate diagnosis.
          </p>
        </div>
        <button
          className="button"
          type="button"
          onClick={onAudit}
          disabled={busy}
        >
          {busy ? "Auditing PayPal…" : "Audit next 50"}
        </button>
      </div>

      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {status ? (
        <>
          <div className={styles.healthLine}>
            <div>
              <span>Current gate</span>
              <strong>{healthLabel(status)}</strong>
            </div>
            <div>
              <span>Audit interval</span>
              <strong>{status.auditIntervalSeconds / 3_600} hours</strong>
            </div>
            <div>
              <span>Queue lag</span>
              <strong>{duration(status.queueLagSeconds)}</strong>
            </div>
            <div>
              <span>Last receipt</span>
              <strong>{stamp(status.lastReceiptAt)}</strong>
            </div>
          </div>

          <dl className={styles.counts}>
            <div>
              <dt>Known attempts</dt>
              <dd>{status.knownAttempts}</dd>
            </div>
            <div>
              <dt>Known captures</dt>
              <dd>{status.knownCaptures}</dd>
            </div>
            <div>
              <dt>Active attempts</dt>
              <dd>{status.activeAttempts}</dd>
            </div>
            <div>
              <dt>Stale facts</dt>
              <dd>{status.staleFacts}</dd>
            </div>
            <div>
              <dt>Verified receipts</dt>
              <dd>{status.receiptCount}</dd>
            </div>
            <div>
              <dt>Credential failures</dt>
              <dd>{status.credentialFailures}</dd>
            </div>
          </dl>
        </>
      ) : null}

      {run ? (
        <div className={styles.run} aria-labelledby="latest-run-heading">
          <div className={styles.runHeading}>
            <div>
              <h2 id="latest-run-heading">Latest bounded audit</h2>
              <p>{stamp(run.generatedAt)}</p>
            </div>
            <span className={run.audit.unresolved + run.webhooks.unresolved > 0
              ? styles.unresolved
              : styles.clear}
            >
              {run.audit.unresolved + run.webhooks.unresolved > 0
                ? "Operational follow-up required"
                : "No unresolved result"}
            </span>
          </div>
          <dl className={styles.runFacts}>
            <div>
              <dt>Targets audited</dt>
              <dd>{run.audit.audited}</dd>
            </div>
            <div>
              <dt>Exact refreshes</dt>
              <dd>{run.audit.exactRefreshes}</dd>
            </div>
            <div>
              <dt>Captures discovered</dt>
              <dd>{run.audit.captureDiscoveries}</dd>
            </div>
            <div>
              <dt>Readiness withheld</dt>
              <dd>{run.audit.readinessWithheld}</dd>
            </div>
            <div>
              <dt>Receipts processed</dt>
              <dd>{run.webhooks.processed}</dd>
            </div>
            <div>
              <dt>Credential failures</dt>
              <dd>{run.audit.credentialFailures
                + run.webhooks.credentialFailures}</dd>
            </div>
            <div>
              <dt>Provider failures</dt>
              <dd>{run.audit.providerFailures
                + run.webhooks.providerFailures}</dd>
            </div>
            <div>
              <dt>Unresolved</dt>
              <dd>{run.audit.unresolved + run.webhooks.unresolved}</dd>
            </div>
          </dl>
          <p className={styles.runBoundary}>
            {run.truncated
              ? "More known targets or receipts remain outside this manual batch; the scheduled one-shot CLI continues through every bounded page."
              : "This manual batch covered every currently known target and retained receipt in scope."}
            {" "}
            No provider identifier, token, hidden-project amount, or raw
            provider error is displayed.
          </p>
        </div>
      ) : (
        <div className={styles.empty}>
          <strong>No manual audit has run in this browser session.</strong>
          <p>
            Dry health above reads local operational aggregates only. Use the
            explicit audit when an immediate authoritative provider read is
            warranted.
          </p>
        </div>
      )}
    </section>
  );
}

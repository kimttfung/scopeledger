import React from "react";
import type { ProviderPaymentException } from "../../api/provider/payment-exceptions/service";

function stamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function money(currency: "USD", value: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(value));
}

function stateLabel(state: ProviderPaymentException["state"]): string {
  return state.replaceAll("-", " ");
}

export function PaymentExceptionRegisterView({
  exceptions,
  busy,
  message,
  error,
  onRefresh,
  styles,
}: {
  exceptions: readonly ProviderPaymentException[] | null;
  busy: boolean;
  message: string | null;
  error: string | null;
  onRefresh: () => void;
  styles: Readonly<Record<string, string>>;
}) {
  if (!exceptions && !error) {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-label="Loading payment exception register"
      >
        <span />
        <span />
        <span />
      </div>
    );
  }

  return (
    <div className={styles.register}>
      <div className={styles.toolbar}>
        <div>
          <strong>Authoritative observation register</strong>
          <p>
            Refresh re-reads exact PayPal resources. It never initiates a
            refund, creates another attempt, or overrides an outcome.
          </p>
        </div>
        <button
          className="button"
          type="button"
          onClick={onRefresh}
          disabled={busy}
        >
          {busy ? "Refreshing PayPal…" : "Refresh from PayPal"}
        </button>
      </div>

      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {!exceptions || exceptions.length === 0 ? (
        <div className={styles.empty}>
          <strong>No payment exception has been observed.</strong>
          <p>
            Completed capture facts remain unchanged. Use the refresh only
            when a verified PayPal webhook or finance review calls for it.
          </p>
        </div>
      ) : (
        <ol className={styles.rows}>
          {exceptions.map((exception) => (
            <li
              className={styles.row}
              key={exception.observationId}
            >
              <div className={styles.rowHeading}>
                <div>
                  <h2>{exception.unitTitle}</h2>
                  <p>
                    {exception.projectName} · {exception.requestTitle}
                  </p>
                </div>
                <span
                  className={exception.activeFinancialHold
                    ? styles.blockingStatus
                    : styles.observedStatus}
                >
                  {exception.activeFinancialHold
                    ? "Readiness withheld"
                    : "Observed; no new hold"}
                </span>
              </div>

              <dl className={styles.facts}>
                <div>
                  <dt>Observation</dt>
                  <dd>{stateLabel(exception.state)}</dd>
                </div>
                <div>
                  <dt>Provider status</dt>
                  <dd>{exception.providerStatus}</dd>
                </div>
                <div>
                  <dt>Affected amount</dt>
                  <dd>
                    {exception.affectedGross
                      ? money(exception.currency, exception.affectedGross)
                      : "Not established"}
                  </dd>
                </div>
                <div>
                  <dt>Original capture</dt>
                  <dd>{money(exception.currency, exception.captureGross)}</dd>
                </div>
              </dl>

              <div className={styles.lineage}>
                <div>
                  <span>Provider resource</span>
                  <code>{exception.providerResourceId}</code>
                </div>
                <div>
                  <span>Capture</span>
                  <code>{exception.captureId}</code>
                </div>
                <div>
                  <span>Observed</span>
                  <strong>{stamp(exception.observedAt)} UTC</strong>
                </div>
              </div>

              <p className={styles.history}>
                {exception.workStart
                  ? `Actual work start remains recorded for version ${
                      exception.workStart.version
                    } at ${stamp(exception.workStart.recordedAt)} UTC.`
                  : "No actual work start is recorded."}
                {" "}
                The original capture and agreement history are not rewritten.
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

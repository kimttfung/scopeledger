"use client";

import { useRef, useState } from "react";
import type {
  BaselineConfirmation,
  BaselinePreview,
} from "../../api/provider/authoring/baseline-service";
import type {
  ProviderSourceSummary,
} from "../../api/provider/sources/service";
import styles from "./authoring.module.css";

type PreviewResponse = Readonly<{
  ok: true;
  preview: BaselinePreview;
}>;

type ConfirmationResponse = Readonly<{
  ok: true;
  baseline: BaselineConfirmation;
}>;

async function jsonResponse<T extends Readonly<{ ok: true }>>(
  response: Response,
): Promise<T> {
  const body = await response.json() as unknown;
  if (
    !body
    || typeof body !== "object"
    || !("ok" in body)
    || body.ok !== true
    || !response.ok
  ) {
    throw new Error(
      body
        && typeof body === "object"
        && "message" in body
        && typeof body.message === "string"
        ? body.message
        : "Baseline confirmation is unavailable.",
    );
  }
  return body as T;
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function BaselineConfirmationPanel({
  projectId,
  requestId,
  sources,
}: Readonly<{
  projectId: string;
  requestId: string;
  sources: readonly ProviderSourceSummary[];
}>) {
  const [sourceLocator, setSourceLocator] = useState(
    sources[0]?.locator ?? "",
  );
  const [preview, setPreview] = useState<BaselinePreview | null>(null);
  const [confirmation, setConfirmation] =
    useState<BaselineConfirmation | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const confirmationKey = useRef<string | null>(null);

  function chooseSource(locator: string) {
    setSourceLocator(locator);
    setPreview(null);
    setConfirmation(null);
    setConfirmed(false);
    setError(null);
    setMessage(null);
    confirmationKey.current = null;
  }

  async function previewBaseline(event: React.FormEvent) {
    event.preventDefault();
    if (!sourceLocator) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setConfirmation(null);
    setConfirmed(false);
    confirmationKey.current = null;
    try {
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/baselines/preview`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sourceLocator }),
        },
      );
      const body = await jsonResponse<PreviewResponse>(response);
      setPreview(body.preview);
      setMessage(
        body.preview.alreadyConfirmed
          ? "This exact source version is already a confirmed baseline."
          : body.preview.confirmationAllowed
            ? "Baseline preview loaded. No baseline has been confirmed."
            : "Baseline preview loaded, but confirmation is blocked by source attestation or sharing state.",
      );
    } catch (previewError) {
      setPreview(null);
      setError(previewError instanceof Error
        ? previewError.message
        : "Baseline preview could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmBaseline() {
    if (!preview || !confirmed || !preview.confirmationAllowed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      confirmationKey.current ??= crypto.randomUUID();
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/baselines/confirm`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sourceLocator: preview.sourceLocator,
            previewLocator: preview.previewLocator,
            idempotencyKey: confirmationKey.current,
            confirmed: true,
          }),
        },
      );
      const body = await jsonResponse<ConfirmationResponse>(response);
      setConfirmation(body.baseline);
      setPreview((current) => current
        ? {
          ...current,
          alreadyConfirmed: true,
          confirmedAt: body.baseline.confirmedAt,
        }
        : current);
      setMessage(
        body.baseline.duplicate
          ? "The exact source version was already confirmed as a baseline."
          : "The exact source version is now an immutable confirmed baseline.",
      );
    } catch (confirmationError) {
      setError(confirmationError instanceof Error
        ? confirmationError.message
        : "Baseline confirmation could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={styles.baseline}
      aria-labelledby="baseline-confirmation-title"
    >
      <div className={styles.baselineHeading}>
        <div>
          <h2 id="baseline-confirmation-title">Confirmed baseline</h2>
          <p>
            Preview one exact admitted source version, then explicitly attest it
            as project baseline context. Uploading alone never confirms a baseline.
          </p>
        </div>
        <span className={styles.readiness} data-ready={Boolean(confirmation)}>
          {confirmation ? "Baseline confirmed" : "Explicit confirmation required"}
        </span>
      </div>

      {sources.length === 0 ? (
        <p className={styles.blockedNotice}>
          Admit a permitted source before previewing a project baseline.
        </p>
      ) : (
        <form className={styles.baselineForm} onSubmit={previewBaseline}>
          <div className={styles.fieldGroup}>
            <label htmlFor="baseline-source">Admitted source version</label>
            <select
              className={styles.select}
              id="baseline-source"
              value={sourceLocator}
              onChange={(event) => chooseSource(event.target.value)}
              disabled={busy}
              required
            >
              {sources.map((source) => (
                <option key={source.locator} value={source.locator}>
                  {source.displayReference} · {source.originalName ?? "Unnamed source"}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.buttonRow}>
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Reading exact source…" : "Preview baseline confirmation"}
            </button>
          </div>
        </form>
      )}

      {preview && (
        <section
          className={styles.baselinePreview}
          aria-labelledby="baseline-preview-title"
        >
          <div className={styles.previewHeading}>
            <div>
              <h2 id="baseline-preview-title">Baseline preview</h2>
              <p>
                Server-read source, provenance, acceptance, and permission state.
                These facts are not accepted from the browser.
              </p>
            </div>
            <span
              className={styles.readiness}
              data-ready={preview.confirmationAllowed}
            >
              {preview.confirmationAllowed
                ? "Eligible to confirm"
                : "Confirmation blocked"}
            </span>
          </div>
          <dl className={styles.baselineLedger}>
            <div>
              <dt>Source</dt>
              <dd>{preview.displayReference}</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>{preview.originalName ?? "Unnamed source"} · {preview.mediaType}</dd>
            </div>
            <div>
              <dt>Provenance</dt>
              <dd>
                {preview.provenanceOrigin}
                {preview.originReference ? ` · ${preview.originReference}` : ""}
              </dd>
            </div>
            <div>
              <dt>Import acceptance</dt>
              <dd>{preview.acceptance.kind} · {preview.acceptance.basis}</dd>
            </div>
            <div>
              <dt>Studio sharing</dt>
              <dd>{preview.studioSharing}</dd>
            </div>
            <div>
              <dt>Current baseline status</dt>
              <dd>
                {preview.alreadyConfirmed && preview.confirmedAt
                  ? `Confirmed ${timestamp(preview.confirmedAt)}`
                  : "Not confirmed"}
              </dd>
            </div>
          </dl>

          {preview.confirmationAllowed && !preview.alreadyConfirmed && (
            <div className={styles.confirmPublication}>
              <label htmlFor="baseline-confirmation">
                <input
                  id="baseline-confirmation"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy}
                />
                I reviewed this exact source preview and attest that it is the
                provider-confirmed baseline context for this project.
              </label>
              <button
                className="button"
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void confirmBaseline()}
              >
                {busy ? "Confirming baseline…" : "Confirm exact baseline"}
              </button>
            </div>
          )}
        </section>
      )}

      <p
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error ?? message ?? ""}
      </p>
    </section>
  );
}

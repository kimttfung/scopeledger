"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  LocalClientApproverActivation,
} from "../../api/provider/authoring/participant-service";
import styles from "./authoring.module.css";

type PreviewResponse = Readonly<{
  ok: true;
  activation: LocalClientApproverActivation;
}>;

type ActivationResponse = Readonly<{
  ok: true;
  activation: LocalClientApproverActivation;
  duplicate: boolean;
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
        : "Local client-approver activation is unavailable.",
    );
  }
  return body as T;
}

export default function ParticipantActivation({
  projectId,
  projectLabel,
}: {
  projectId: string;
  projectLabel: string;
}) {
  const [preview, setPreview] =
    useState<LocalClientApproverActivation | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function previewActivation() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/participants/local-client-approver`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
      );
      const body = await jsonResponse<PreviewResponse>(response);
      setPreview(body.activation);
      setConfirmed(false);
      setMessage(
        body.activation.status === "active"
          ? "The recorded project-scoped activation is current."
          : "Preview ready. Review the exact authority boundary before confirming.",
      );
    } catch (previewError) {
      setError(previewError instanceof Error
        ? previewError.message
        : "The activation preview could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!preview || preview.status !== "ready" || !confirmed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/participants/local-client-approver`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            confirmationLocator: preview.confirmationLocator,
            confirmed: true,
          }),
        },
      );
      const body = await jsonResponse<ActivationResponse>(response);
      setPreview(body.activation);
      setConfirmed(false);
      setMessage(
        body.duplicate
          ? "The exact activation was already recorded and remains current."
          : "Local client-approver authority is active for this project.",
      );
    } catch (activationError) {
      setError(activationError instanceof Error
        ? activationError.message
        : "Local client-approver authority could not be activated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={styles.participantActivation}
      aria-labelledby="participant-activation-title"
    >
      <div className={styles.participantHeading}>
        <div>
          <h2 id="participant-activation-title">Local client approver</h2>
          <p>
            Preview and explicitly activate the fixed local demo participant for{" "}
            <strong>{projectLabel}</strong>.
          </p>
        </div>
        <span
          className={styles.readiness}
          data-ready={preview?.status === "active"}
        >
          {preview?.status === "active"
            ? "Authority active"
            : preview
              ? "Confirmation required"
              : "Not previewed"}
        </span>
      </div>

      {!preview ? (
        <div className={styles.participantIntroduction}>
          <p>
            This action is project-scoped and prospective. It does not change
            published terms, existing actors, recorded decisions, payment, or
            work readiness.
          </p>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void previewActivation()}
          >
            {busy ? "Reading activation preview…" : "Preview local client authority"}
          </button>
        </div>
      ) : (
        <div className={styles.participantPreview}>
          <div className={styles.participantBoundary}>
            <div>
              <h3>Prospective authority for this project</h3>
              <ul>
                <li>Inspect the published client review.</li>
                <li>Record an exact approve or decline decision.</li>
                <li>Submit a project-scoped context correction.</li>
              </ul>
            </div>
            <div>
              <h3>Authority not created</h3>
              <ul>
                <li>No payer nomination or payment permission.</li>
                <li>No rewrite of prior actors, decisions, or publication history.</li>
                <li>No authority for any other project.</li>
              </ul>
            </div>
          </div>
          <p className={styles.participantNotice}>
            <strong>Local channel verification remains separate.</strong>{" "}
            Verifying the local client recipient proves channel control only.
            It does not nominate or activate project authority.
          </p>

          {preview.status === "ready" ? (
            <div className={styles.participantConfirmation}>
              <label htmlFor="participant-activation-confirmation">
                <input
                  id="participant-activation-confirmation"
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  I confirm prospective inspect, decide, and correct authority
                  for the fixed local demo client approver on this project only.
                </span>
              </label>
              <button
                className="button"
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void activate()}
              >
                {busy ? "Activating authority…" : "Activate local client approver"}
              </button>
            </div>
          ) : (
            <div className={styles.participantActive}>
              <div>
                <strong>Project-scoped authority is active.</strong>
                <span>
                  Complete the separate local client channel verification before
                  opening the existing opaque review URL.
                </span>
              </div>
              <Link className="button" href="/access-demo">
                Verify local client channel
              </Link>
            </div>
          )}

          <button
            className={styles.textButton}
            type="button"
            disabled={busy}
            onClick={() => void previewActivation()}
          >
            Refresh activation preview
          </button>
        </div>
      )}

      <p
        className={`${styles.participantStatus} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error ?? message ?? ""}
      </p>
    </section>
  );
}

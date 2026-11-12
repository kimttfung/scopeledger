"use client";

import Link from "next/link";
import {
  useRef,
  useState,
} from "react";
import type {
  ParticipantOperation,
  ParticipantPreview,
  ProviderParticipant,
} from "../../api/provider/participants/service";
import styles from "./participants.module.css";

type ListResponse =
  | Readonly<{
    ok: true;
    participants: readonly ProviderParticipant[];
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
  }>;

type PreviewResponse =
  | Readonly<{ ok: true; preview: ParticipantPreview }>
  | Readonly<{ ok: false; code: string; message: string }>;

type ConfirmResponse =
  | Readonly<{
    ok: true;
    participant: ProviderParticipant;
    duplicate: boolean;
  }>
  | Readonly<{ ok: false; code: string; message: string }>;

const operationLabels: Record<ParticipantOperation, string> = {
  "revoke-approver": "Revoke current approver",
  "restore-approver": "Restore fixed local approver",
  "revoke-payer": "Revoke current payer",
  "restore-payer": "Restore fixed local payer",
};

const statusLabels: Record<ProviderParticipant["status"], string> = {
  active: "Current authority active",
  revoked: "Prospective authority revoked",
  "replacement-active": "Replacement authority active",
  "continuity-changed": "Continuity requires confirmation",
  incomplete: "Authority state incomplete",
  "not-assigned": "No payer assigned",
};

async function responseBody<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  const body = await response.json() as unknown;
  if (
    !response.ok
    || !body
    || typeof body !== "object"
    || !("ok" in body)
    || body.ok !== true
  ) {
    throw new Error(
      body
        && typeof body === "object"
        && "message" in body
        && typeof body.message === "string"
        ? body.message
        : fallback,
    );
  }
  return body as T;
}

function ParticipantActions({
  participant,
  busy,
  onPreview,
}: Readonly<{
  participant: ProviderParticipant;
  busy: boolean;
  onPreview: (
    participant: ProviderParticipant,
    operation: ParticipantOperation,
  ) => void;
}>) {
  if (participant.availableOperations.length === 0) {
    return (
      <p className={styles.noAction}>
        {participant.kind === "obligation-payer"
          && participant.status === "not-assigned"
          ? (
            <Link href="/provider/payments">
              Use payer authority to activate this approved obligation
            </Link>
          )
          : "No lifecycle action is currently available."}
      </p>
    );
  }
  return (
    <div className={styles.actions}>
      {participant.availableOperations.map((operation) => (
        <button
          className="button"
          type="button"
          key={operation}
          disabled={busy}
          onClick={() => onPreview(participant, operation)}
        >
          {operationLabels[operation]}
        </button>
      ))}
    </div>
  );
}

function AuthorityRow({
  participant,
  busy,
  onPreview,
}: Readonly<{
  participant: ProviderParticipant;
  busy: boolean;
  onPreview: (
    participant: ProviderParticipant,
    operation: ParticipantOperation,
  ) => void;
}>) {
  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <h3>{participant.projectLabel}</h3>
        {participant.requestLabel && participant.unitTitle ? (
          <p>
            {participant.requestLabel}
            <span aria-hidden="true"> · </span>
            {participant.unitTitle}
          </p>
        ) : (
          <p>Project-scoped client review authority</p>
        )}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Participant</dt>
          <dd>{participant.participantLabel}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{statusLabels[participant.status]}</dd>
        </div>
        {participant.amount ? (
          <div>
            <dt>Approved obligation</dt>
            <dd className={styles.money}>
              {participant.amount.currency} {participant.amount.gross}
            </dd>
          </div>
        ) : null}
        {participant.recovery === "admitted-capture" ? (
          <div>
            <dt>Recovery</dt>
            <dd>Admitted capture remains recoverable</dd>
          </div>
        ) : null}
      </dl>
      <ParticipantActions
        participant={participant}
        busy={busy}
        onPreview={onPreview}
      />
    </li>
  );
}

export default function ParticipantRegister({
  initialParticipants,
}: Readonly<{
  initialParticipants: readonly ProviderParticipant[];
}>) {
  const [participants, setParticipants] = useState(initialParticipants);
  const [preview, setPreview] = useState<ParticipantPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const approvers = participants.filter((participant) =>
    participant.kind === "project-approver");
  const payers = participants.filter((participant) =>
    participant.kind === "obligation-payer");

  async function refresh() {
    const response = await fetch("/api/provider/participants", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = await responseBody<ListResponse & { ok: true }>(
      response,
      "Participant authority could not be refreshed.",
    );
    setParticipants(body.participants);
  }

  async function openPreview(
    participant: ProviderParticipant,
    operation: ParticipantOperation,
  ) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/provider/participants/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          selector: participant.selector,
          operation,
        }),
      });
      const body = await responseBody<PreviewResponse & { ok: true }>(
        response,
        "The participant preview could not be prepared.",
      );
      setPreview(body.preview);
      setConfirmed(false);
      dialogRef.current?.showModal();
    } catch (previewError) {
      setError(previewError instanceof Error
        ? previewError.message
        : "The participant preview could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  function closePreview() {
    dialogRef.current?.close();
    setPreview(null);
    setConfirmed(false);
  }

  async function confirmPreview() {
    if (!preview || !confirmed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/provider/participants/confirm", {
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
      });
      const body = await responseBody<ConfirmResponse & { ok: true }>(
        response,
        "The participant authority change could not be recorded.",
      );
      setParticipants((current) => current.map((participant) =>
        participant.selector === body.participant.selector
          ? body.participant
          : participant));
      closePreview();
      setMessage(
        body.duplicate
          ? "The exact participant authority change was already recorded and remains current."
          : `${operationLabels[preview.operation]} recorded.`,
      );
      try {
        await refresh();
      } catch {
        setError(
          "The authority change was recorded, but the register could not be refreshed. Reload this page before taking another action.",
        );
      }
    } catch (confirmationError) {
      setError(confirmationError instanceof Error
        ? confirmationError.message
        : "The participant authority change could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className={styles.register} aria-labelledby="approver-register">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="approver-register">Project approvers</h2>
            <p>
              Current project-scoped inspect, decide, and correct authority.
            </p>
          </div>
          <span>{approvers.length} project{approvers.length === 1 ? "" : "s"}</span>
        </div>
        {approvers.length === 0 ? (
          <p className={styles.empty}>
            No provider-authorized projects are available.
          </p>
        ) : (
          <ul className={styles.rows}>
            {approvers.map((participant) => (
              <AuthorityRow
                key={participant.selector}
                participant={participant}
                busy={busy}
                onPreview={(selected, operation) =>
                  void openPreview(selected, operation)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.register} aria-labelledby="payer-register">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="payer-register">Approved-obligation payers</h2>
            <p>
              Exact obligation-scoped payment authority, separate from project
              approval.
            </p>
          </div>
          <span>{payers.length} obligation{payers.length === 1 ? "" : "s"}</span>
        </div>
        {payers.length === 0 ? (
          <p className={styles.empty}>
            No current approved payable obligations are available.
          </p>
        ) : (
          <ul className={styles.rows}>
            {payers.map((participant) => (
              <AuthorityRow
                key={participant.selector}
                participant={participant}
                busy={busy}
                onPreview={(selected, operation) =>
                  void openPreview(selected, operation)}
              />
            ))}
          </ul>
        )}
      </section>

      <p
        className={`${styles.feedback} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error ?? message ?? ""}
      </p>

      <dialog
        className={styles.dialog}
        ref={dialogRef}
        onCancel={closePreview}
        onClose={() => {
          setPreview(null);
          setConfirmed(false);
        }}
      >
        {preview ? (
          <>
            <div className={styles.dialogHeading}>
              <div>
                <h2>{operationLabels[preview.operation]}</h2>
                <p>{preview.projectLabel}</p>
              </div>
              <button
                className={styles.closeButton}
                type="button"
                aria-label="Close participant preview"
                disabled={busy}
                onClick={closePreview}
              >
                ×
              </button>
            </div>
            {preview.requestLabel && preview.unitTitle ? (
              <p className={styles.obligationHeading}>
                {preview.requestLabel}
                <span aria-hidden="true"> · </span>
                {preview.unitTitle}
                {preview.amount
                  ? ` · ${preview.amount.currency} ${preview.amount.gross}`
                  : ""}
              </p>
            ) : null}
            <div className={styles.previewColumns}>
              <div>
                <h3>Prospective effect</h3>
                <ul>
                  {preview.effect.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
              <div>
                <h3>Preserved records and boundaries</h3>
                <ul>
                  {preview.preserved.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            </div>
            {preview.requiresReissue ? (
              <p className={styles.notice}>
                <strong>Reissue required.</strong> Any affected unaccepted
                published unit remains immutable and cannot use consent from the
                earlier approver epoch.
              </p>
            ) : null}
            {preview.admittedCaptureRecoveryPreserved ? (
              <p className={styles.notice}>
                <strong>Recovery remains available.</strong> This revocation
                blocks new payment admissions but does not suppress recovery of
                the already-admitted capture operation.
              </p>
            ) : null}
            <label
              className={styles.confirmation}
              htmlFor="participant-lifecycle-confirmation"
            >
              <input
                id="participant-lifecycle-confirmation"
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                I confirm this exact prospective authority change for{" "}
                {preview.participantLabel.toLowerCase()}.
              </span>
            </label>
            <div className={styles.dialogActions}>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={closePreview}
              >
                Return without changing authority
              </button>
              <button
                className="button"
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void confirmPreview()}
              >
                {busy ? "Recording authority…" : operationLabels[preview.operation]}
              </button>
            </div>
          </>
        ) : null}
      </dialog>
    </>
  );
}

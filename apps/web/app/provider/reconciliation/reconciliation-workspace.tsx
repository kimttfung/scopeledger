"use client";

import { useEffect, useState } from "react";
import type { ReconciliationInbox } from "../../api/provider/reconciliation/service";
import {
  CorrectionForm,
  QuestionForm,
} from "./reconciliation-forms";
import styles from "./reconciliation.module.css";

type InboxResponse =
  | Readonly<{ ok: true; inbox: ReconciliationInbox }>
  | Readonly<{ ok: false; code: string; message: string }>;

function stamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

async function loadInbox(): Promise<ReconciliationInbox> {
  const response = await fetch("/api/provider/reconciliation", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const body = await response.json() as InboxResponse;
  if (!response.ok || !body.ok) {
    throw new Error(
      body.ok
        ? "The protected reconciliation inbox could not be loaded."
        : body.message,
    );
  }
  return body.inbox;
}

export default function ReconciliationWorkspace() {
  const [inbox, setInbox] = useState<ReconciliationInbox | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadInbox().then((loaded) => {
      if (active) setInbox(loaded);
    }).catch((cause: unknown) => {
      if (active) {
        setError(cause instanceof Error ? cause.message : "Inbox unavailable.");
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const notice = await work();
      setMessage(notice);
      setInbox(await loadInbox());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operation unavailable.");
    } finally {
      setBusy(false);
    }
  };

  if (!inbox && !error) {
    return (
      <div className={styles.loading} role="status" aria-label="Loading protected inbox">
        <span />
        <span />
        <span />
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <section className={styles.section} aria-labelledby="questions-title">
        <div className={styles.sectionTitle}>
          <div>
            <span>Communication register</span>
            <h2 id="questions-title">Client questions</h2>
          </div>
          <p>
            Responses are attributed communication only. They do not create or
            clear a review hold, change consent, or move money.
          </p>
        </div>
        {!inbox || inbox.questions.length === 0 ? (
          <p className={styles.empty}>No authorized question is available.</p>
        ) : (
          <ul className={styles.items}>
            {inbox.questions.map((question) => (
              <li key={question.questionId} className={styles.item}>
                <div className={styles.itemHeading}>
                  <div>
                    <strong>{question.unitTitle}</strong>
                    <span>
                      {question.projectName} · {question.requestTitle} · version{" "}
                      {question.version}
                    </span>
                  </div>
                  <span className={styles.status}>{question.status}</span>
                </div>
                <blockquote>{question.text}</blockquote>
                <p className={styles.attribution}>
                  {question.asked.label} · {stamp(question.asked.at)} UTC
                </p>
                {question.latestResponse ? (
                  <div className={styles.priorResponse}>
                    <strong>Latest provider response</strong>
                    <p>{question.latestResponse.text}</p>
                    <span>
                      {question.latestResponse.attribution.label} ·{" "}
                      {stamp(question.latestResponse.attribution.at)} UTC
                    </span>
                  </div>
                ) : null}
                <QuestionForm
                  question={question}
                  busy={busy}
                  submit={submit}
                  styles={styles}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="corrections-title">
        <div className={styles.sectionTitle}>
          <div>
            <span>Applicability register</span>
            <h2 id="corrections-title">Correction concerns</h2>
          </div>
          <p>
            No-material responses await explicit client acknowledgement.
            Material responses create a draft only; old consent is never reused.
          </p>
        </div>
        {!inbox || inbox.corrections.length === 0 ? (
          <p className={styles.empty}>No authorized correction is available.</p>
        ) : (
          <ul className={styles.items}>
            {inbox.corrections.map((correction) => (
              <li key={correction.concernId} className={styles.item}>
                <div className={styles.itemHeading}>
                  <div>
                    <strong>{correction.unitTitle}</strong>
                    <span>
                      {correction.projectName} · {correction.requestTitle} ·
                      version {correction.version}
                    </span>
                  </div>
                  <span className={styles.status}>
                    {correction.correctionHoldActive
                      ? "correction hold active"
                      : "client resolved"}
                  </span>
                </div>
                <blockquote>{correction.statement}</blockquote>
                <dl className={styles.facts}>
                  <div>
                    <dt>Claimed source</dt>
                    <dd>{correction.claimedSourceType}</dd>
                  </div>
                  <div>
                    <dt>Source availability</dt>
                    <dd>{correction.sourceAvailability}</dd>
                  </div>
                  <div>
                    <dt>Other hold</dt>
                    <dd>{correction.otherHoldPresent ? "Present" : "None active"}</dd>
                  </div>
                </dl>
                {correction.latestAssessment ? (
                  <div className={styles.priorResponse}>
                    <strong>
                      Latest assessment:{" "}
                      {correction.latestAssessment.applicability}
                    </strong>
                    <span>
                      {correction.latestAssessment.attribution.label} ·{" "}
                      {stamp(correction.latestAssessment.attribution.at)} UTC
                    </span>
                    {correction.latestAssessment.reissueDraftRevision ? (
                      <p>
                        In-progress reissue draft revision{" "}
                        {correction.latestAssessment.reissueDraftRevision};
                        normal commercial preparation and publication remain
                        required.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <CorrectionForm
                  correction={correction}
                  busy={busy}
                  submit={submit}
                  styles={styles}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

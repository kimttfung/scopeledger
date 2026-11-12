"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  WorkStartFact,
  WorkStartSnapshot,
} from "../../api/provider/operations/work-start/service";
import styles from "./operations.module.css";

type SuccessGet = Readonly<{
  ok: true;
  snapshot: WorkStartSnapshot;
}>;

type SuccessPost = Readonly<{
  ok: true;
  recorded: true;
  workStart: WorkStartFact;
}>;

type Failure = Readonly<{
  ok: false;
  code: string;
  message: string;
}>;

function readinessLabel(readiness: WorkStartSnapshot["readiness"]): string {
  switch (readiness) {
    case "awaiting-agreement":
      return "Awaiting agreement";
    case "review-hold":
      return "Review hold";
    case "awaiting-payment":
      return "Awaiting payment";
    case "awaiting-prerequisite":
      return "Awaiting prerequisite";
    case "financial-recheck":
      return "Financial recheck required";
    case "ready":
      return "Ready";
  }
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function fetchSnapshot(): Promise<WorkStartSnapshot> {
  const response = await fetch("/api/provider/operations/work-start", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = await response.json() as SuccessGet | Failure;
  if (!response.ok || !body.ok) {
    throw new Error(body.ok
      ? "Current operational state is unavailable."
      : body.message);
  }
  return body.snapshot;
}

export default function WorkStartPanel() {
  const [snapshot, setSnapshot] = useState<WorkStartSnapshot | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await fetchSnapshot());
    } catch (loadError) {
      setError(loadError instanceof Error
        ? loadError.message
        : "Current operational state is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchSnapshot()
      .then((current) => {
        if (active) setSnapshot(current);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error
            ? loadError.message
            : "Current operational state is unavailable.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function recordWorkStart() {
    if (!snapshot || snapshot.readiness !== "ready" || snapshot.workStart) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/provider/operations/work-start", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const body = await response.json() as SuccessPost | Failure;
      if (!response.ok || !body.ok) {
        throw new Error(body.ok ? "Work start could not be recorded." : body.message);
      }
      setSnapshot((current) => current
        ? { ...current, workStart: body.workStart }
        : current);
      setConfirmed(false);
      setMessage("Actual work start is recorded as a separate operational fact.");
    } catch (recordError) {
      setError(recordError instanceof Error
        ? recordError.message
        : "Work start could not be recorded.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !snapshot) {
    return <p className={styles.loading} role="status">Reading current server state…</p>;
  }

  if (!snapshot) {
    return (
      <section className={styles.action} aria-labelledby="operations-unavailable">
        <h2 id="operations-unavailable">Operational state unavailable</h2>
        <p className={styles.error} role="alert">
          {error ?? "Current operational state could not be read."}
        </p>
        <div className={styles.actions}>
          <button className="button" type="button" onClick={() => void load()}>
            Try again
          </button>
          <Link className="button" href="/provider">
            Return to provider access
          </Link>
        </div>
      </section>
    );
  }

  const canRecord = snapshot.readiness === "ready"
    && snapshot.activeHoldCount === 0
    && snapshot.workStart === null;

  return (
    <>
      <dl className={styles.ledger}>
        <div className={styles.row}>
          <dt className={styles.label}>Work unit</dt>
          <dd className={styles.value}>
            Cedar Roastery
            <span className={styles.detail}>
              Accepted version {snapshot.acceptedVersion ?? "not established"}
            </span>
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.label}>Readiness</dt>
          <dd className={styles.value}>
            {readinessLabel(snapshot.readiness)}
            <span className={styles.detail}>
              Re-read from the server; the browser cannot declare readiness.
            </span>
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.label}>Active holds</dt>
          <dd className={styles.value}>
            {snapshot.activeHoldCount === 0
              ? "None"
              : snapshot.activeHoldCount}
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.label}>Actual work start</dt>
          <dd className={styles.value}>
            {snapshot.workStart
              ? `Recorded ${timestamp(snapshot.workStart.startedAt)}`
              : "Not recorded"}
            <span className={styles.detail}>
              {snapshot.workStart
                ? `Separate fact for accepted version ${snapshot.workStart.version}; readiness remains independently visible.`
                : "Being ready does not itself mean work has begun."}
            </span>
          </dd>
        </div>
      </dl>

      <section className={styles.action} aria-labelledby="record-work-start-title">
        <h2 id="record-work-start-title">Record actual work start</h2>
        <p>
          Use this only after work has actually begun. The server will lock and
          re-check agreement, payment, prerequisites, and holds before recording.
        </p>
        {!snapshot.workStart && (
          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!canRecord || submitting}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I confirm that work has actually started.</span>
          </label>
        )}
        <div className={styles.actions}>
          <button
            className="button"
            type="button"
            disabled={!canRecord || !confirmed || submitting}
            onClick={() => void recordWorkStart()}
          >
            {submitting ? "Recording…" : snapshot.workStart
              ? "Work start recorded"
              : "Record actual work start"}
          </button>
          <button
            className="button"
            type="button"
            disabled={loading || submitting}
            onClick={() => void load()}
          >
            {loading ? "Refreshing…" : "Refresh server state"}
          </button>
          <Link className="button" href="/provider">
            Provider access
          </Link>
        </div>
        <p
          className={`${styles.status} ${error ? styles.error : ""}`}
          role={error ? "alert" : "status"}
        >
          {error
            ?? message
            ?? (!canRecord && !snapshot.workStart
              ? "Recording is disabled until the server reports ready with no active hold."
              : "")}
        </p>
      </section>
    </>
  );
}

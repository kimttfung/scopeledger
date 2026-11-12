"use client";

import React, { useState } from "react";
import type {
  CorrectionApplicability,
  QuestionResponseStatus,
  ReconciliationCorrection,
  ReconciliationQuestion,
} from "../../api/provider/reconciliation/service";

export type ReconciliationStyles = Readonly<Record<string, string>>;
type Submit = (work: () => Promise<string>) => Promise<void>;

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown; code?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.code === "string") return body.code;
  } catch {
    // The safe fallback below avoids rendering transport details.
  }
  return "The protected reconciliation operation could not be completed.";
}

export function QuestionForm({
  question,
  busy,
  submit,
  styles,
}: {
  question: ReconciliationQuestion;
  busy: boolean;
  submit: Submit;
  styles: ReconciliationStyles;
}) {
  const [status, setStatus] = useState<QuestionResponseStatus>("answered");
  const [response, setResponse] = useState("");

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(async () => {
          const result = await fetch(
            `/api/provider/reconciliation/questions/${encodeURIComponent(question.questionId)}/response`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                idempotencyKey: crypto.randomUUID(),
                expectedVersion: question.version,
                status,
                response,
              }),
            },
          );
          if (!result.ok) throw new Error(await responseMessage(result));
          setResponse("");
          return "Question response recorded without creating a hold.";
        });
      }}
    >
      <label>
        Response status
        <select
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as QuestionResponseStatus)}
          disabled={busy}
        >
          <option value="answered">Answered</option>
          <option value="needs-client-information">
            Needs client information
          </option>
          <option value="closed">Closed</option>
        </select>
      </label>
      <label>
        Provider response
        <textarea
          value={response}
          onChange={(event) => setResponse(event.target.value)}
          required
          maxLength={5_000}
          rows={4}
          disabled={busy}
        />
      </label>
      <button className="button" type="submit" disabled={busy}>
        Record response
      </button>
    </form>
  );
}

export function CorrectionForm({
  correction,
  busy,
  submit,
  styles,
}: {
  correction: ReconciliationCorrection;
  busy: boolean;
  submit: Submit;
  styles: ReconciliationStyles;
}) {
  const [applicability, setApplicability] =
    useState<CorrectionApplicability>("needs-information");
  const [sourceReview, setSourceReview] = useState("");
  const [response, setResponse] = useState("");

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(async () => {
          const result = await fetch(
            `/api/provider/reconciliation/corrections/${encodeURIComponent(correction.concernId)}/assess`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                idempotencyKey: crypto.randomUUID(),
                expectedVersion: correction.version,
                applicability,
                sourceReview,
                response,
              }),
            },
          );
          if (!result.ok) throw new Error(await responseMessage(result));
          const body = await result.json() as {
            assessment?: { reissue?: { draftRevision?: number } | null };
          };
          setResponse("");
          setSourceReview("");
          const revision = body.assessment?.reissue?.draftRevision;
          return typeof revision === "number"
            ? `Material assessment recorded. In-progress reissue draft revision ${revision} now requires normal preparation and publication.`
            : "Assessment and provider response recorded. The correction hold remains for explicit client action.";
        });
      }}
    >
      <label>
        Applicability assessment
        <select
          value={applicability}
          onChange={(event) =>
            setApplicability(event.target.value as CorrectionApplicability)}
          disabled={busy || !correction.correctionHoldActive}
        >
          <option value="needs-information">Needs information</option>
          <option value="no-material-change">No material change</option>
          <option value="material-change">Material change</option>
        </select>
      </label>
      <label>
        Source review
        <textarea
          value={sourceReview}
          onChange={(event) => setSourceReview(event.target.value)}
          required
          maxLength={5_000}
          rows={3}
          disabled={busy || !correction.correctionHoldActive}
        />
      </label>
      <label>
        Provider response
        <textarea
          value={response}
          onChange={(event) => setResponse(event.target.value)}
          required
          maxLength={5_000}
          rows={4}
          disabled={busy || !correction.correctionHoldActive}
        />
      </label>
      <button
        className="button"
        type="submit"
        disabled={busy || !correction.correctionHoldActive}
      >
        Record assessment
      </button>
    </form>
  );
}

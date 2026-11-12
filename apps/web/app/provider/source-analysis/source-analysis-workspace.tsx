"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProviderSourceAnalysisCandidate,
  ProviderSourceAnalysisGetResponse,
  ProviderSourceAnalysisPostResponse,
  ProviderSourceAnalysisReviewResponse,
  ProviderSourceAnalysisRun,
} from "../../api/provider/source-analysis/service";
import styles from "./source-analysis.module.css";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("en-US");

function runStatus(status: ProviderSourceAnalysisRun["status"]): string {
  if (status === "candidate-ready") return "Gemini candidates ready";
  if (status === "model-failed") return "Model failed; manual basis saved";
  return "Manual analysis ready";
}

function Candidate({
  candidate,
}: {
  candidate: ProviderSourceAnalysisCandidate;
}) {
  return (
    <details className={styles.candidate}>
      <summary>{candidate.claimId}: {candidate.interpretation}</summary>
      <div className={styles.candidateBody}>
        <p>
          <strong>Uncertainty ({candidate.uncertainty.status}):</strong>{" "}
          {candidate.uncertainty.explanation}
        </p>
        {candidate.uncertainty.questions.length > 0 && (
          <ul>
            {candidate.uncertainty.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        )}
        {candidate.evidence.map((evidence, index) => (
          <blockquote key={`${candidate.claimId}-${index}`}>
            <span>
              {evidence.polarity === "supporting"
                ? "Supporting evidence"
                : "Charge-weakening evidence"}
              {" · "}code points {evidence.start}–{evidence.end}
            </span>
            &ldquo;{evidence.quote}&rdquo;
          </blockquote>
        ))}
      </div>
    </details>
  );
}

function RunCard({ run }: { run: ProviderSourceAnalysisRun }) {
  return (
    <article className={styles.runCard}>
      <div className={styles.runHeading}>
        <div>
          <h3>{run.sourceDisplayReference} · {runStatus(run.status)}</h3>
        </div>
        <time dateTime={run.recordedAt}>
          {dateFormatter.format(new Date(run.recordedAt))}
        </time>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Exact extraction</dt>
          <dd>
            {run.extraction.format} · {run.extraction.status} ·{" "}
            {numberFormatter.format(run.extraction.codePointCount)} code points
          </dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>
            {run.extraction.coverage.map((unit) =>
              `${unit.kind} ${unit.number}: ${
                unit.status === "extracted"
                  ? `${unit.start}–${unit.end}`
                  : "unavailable"
              }`).join("; ")}
          </dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>Human review required · publication blocked</dd>
        </div>
      </dl>
      {run.model.status === "failed" && (
        <p className={styles.warning}>
          Gemini did not complete ({run.model.code}). The exact manual basis
          remains saved.
        </p>
      )}
      {run.model.status === "completed" && (
        <div className={styles.candidates}>
          {run.model.candidates.map((candidate) => (
            <Candidate candidate={candidate} key={candidate.claimId} />
          ))}
          {run.model.missingContext.length > 0 && (
            <div className={styles.missingContext}>
              <strong>Missing context</strong>
              <ul>
                {run.model.missingContext.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {run.reviews.length > 0 && (
        <div className={styles.reviewHistory}>
          <strong>Append-only provider review</strong>
          <ol>
            {run.reviews.map((review) => (
              <li key={review.reviewId}>
                <span>{review.disposition}</span>
                <p>{review.note}</p>
                <time dateTime={review.reviewedAt}>
                  {dateFormatter.format(new Date(review.reviewedAt))}
                </time>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

function isGetResponse(value: unknown): value is ProviderSourceAnalysisGetResponse {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function isPostResponse(
  value: unknown,
): value is ProviderSourceAnalysisPostResponse {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function isReviewResponse(
  value: unknown,
): value is ProviderSourceAnalysisReviewResponse {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

export default function SourceAnalysisWorkspace() {
  const [data, setData] = useState<
    Extract<ProviderSourceAnalysisGetResponse, { ok: true }> | null
  >(null);
  const [projectLocator, setProjectLocator] = useState("");
  const [requestLocator, setRequestLocator] = useState("");
  const [sourceLocator, setSourceLocator] = useState("");
  const [mode, setMode] = useState<"manual" | "gemini">("manual");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selectedRunLocator, setSelectedRunLocator] = useState("");
  const [reviewDisposition, setReviewDisposition] =
    useState<"accept" | "edit" | "reject" | "manual">("manual");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/provider/source-analysis", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body: unknown = await response.json();
      if (!isGetResponse(body)) throw new Error("INVALID_RESPONSE");
      if (!body.ok) {
        setError(`${body.message} Reference code: ${body.code}.`);
        return;
      }
      setData(body);
      setError("");
      setProjectLocator((current) =>
        body.projects.some((project) => project.locator === current)
          ? current
          : body.projects[0]?.locator ?? "");
      setSelectedRunLocator((current) =>
        body.runs.some((run) => run.locator === current)
          ? current
          : body.runs[0]?.locator ?? "");
    } catch {
      setError("Protected admitted-source analysis could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const project = useMemo(
    () => data?.projects.find((item) => item.locator === projectLocator) ?? null,
    [data, projectLocator],
  );
  const request = useMemo(
    () => project?.requests.find((item) => item.locator === requestLocator)
      ?? project?.requests[0]
      ?? null,
    [project, requestLocator],
  );
  const source = useMemo(
    () => request?.sources.find((item) => item.locator === sourceLocator)
      ?? request?.sources[0]
      ?? null,
    [request, sourceLocator],
  );
  const selectedRun = data?.runs.find(
    (run) => run.locator === selectedRunLocator,
  ) ?? null;

  async function analyze(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!project || !request || !source) {
      setError("Choose one admitted provider source.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/provider/source-analysis", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectLocator: project.locator,
          requestLocator: request.locator,
          sourceLocator: source.locator,
          mode,
        }),
      });
      const body: unknown = await response.json();
      if (!isPostResponse(body)) throw new Error("INVALID_RESPONSE");
      if (!body.ok) {
        setError(`${body.message} Reference code: ${body.code}.`);
        if (body.run) setSelectedRunLocator(body.run.locator);
        await load();
        return;
      }
      setMessage(
        mode === "gemini"
          ? "Gemini candidates and exact evidence were saved for human review."
          : "Exact extraction and coverage were saved for manual review.",
      );
      setSelectedRunLocator(body.run.locator);
      await load();
      setSelectedRunLocator(body.run.locator);
    } catch {
      setError(
        "The analysis response could not be verified. Reload persisted runs before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function review(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    const note = reviewNote.trim();
    if (!selectedRun || !note) {
      setError("Choose a persisted run and add a provider review note.");
      return;
    }
    setReviewBusy(true);
    try {
      const response = await fetch(
        "/api/provider/source-analysis/reviews",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runLocator: selectedRun.locator,
            reviewId: crypto.randomUUID(),
            disposition: reviewDisposition,
            note,
          }),
        },
      );
      const body: unknown = await response.json();
      if (!isReviewResponse(body)) throw new Error("INVALID_RESPONSE");
      if (!body.ok) {
        setError(`${body.message} Reference code: ${body.code}.`);
        return;
      }
      setReviewNote("");
      setMessage("The append-only provider review was saved.");
      await load();
    } catch {
      setError("The provider review response could not be verified.");
    } finally {
      setReviewBusy(false);
    }
  }

  return (
    <main className={styles.main} id="source-analysis-main">
      <section className={styles.intro}>
        <div>
          <h1>Analyze the immutable source already on record.</h1>
          <p>
            No second browser upload is required. The server re-reads the
            admitted metadata, exact private bytes, active provider grant, and
            stored permission state before every run.
          </p>
        </div>
        <div className={styles.boundary}>
          <strong>No downstream authority</strong>
          <span>
            Analysis cannot set treatment, price, publication, agreement,
            payment, readiness, or work start.
          </span>
        </div>
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.success} role="status">{message}</p>}

      <section className={styles.workspace}>
        <form className={styles.selector} onSubmit={analyze}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Choose admitted source</h2>
            </div>
            <span>{loading ? "Loading…" : `${data?.projects.length ?? 0} projects`}</span>
          </div>

          <label htmlFor="source-analysis-project">Project</label>
          <select
            id="source-analysis-project"
            value={project?.locator ?? ""}
            onChange={(event) => {
              setProjectLocator(event.target.value);
              setRequestLocator("");
              setSourceLocator("");
            }}
          >
            {(data?.projects ?? []).map((item) => (
              <option key={item.locator} value={item.locator}>
                {item.displayName}
              </option>
            ))}
          </select>

          <label htmlFor="source-analysis-request">Request</label>
          <select
            id="source-analysis-request"
            value={request?.locator ?? ""}
            onChange={(event) => {
              setRequestLocator(event.target.value);
              setSourceLocator("");
            }}
          >
            {(project?.requests ?? []).map((item) => (
              <option key={item.locator} value={item.locator}>
                {item.title}
              </option>
            ))}
          </select>

          <label htmlFor="source-analysis-source">Immutable source version</label>
          <select
            id="source-analysis-source"
            value={source?.locator ?? ""}
            onChange={(event) => setSourceLocator(event.target.value)}
          >
            {(request?.sources ?? []).map((item) => (
              <option key={item.locator} value={item.locator}>
                {item.displayReference} · {item.originalName ?? "Unnamed source"}
              </option>
            ))}
          </select>

          {source && (
            <dl className={styles.sourceFacts}>
              <div>
                <dt>Format</dt>
                <dd>{source.mediaType}</dd>
              </div>
              <div>
                <dt>Studio sharing</dt>
                <dd>{source.studioSharing}</dd>
              </div>
              <div>
                <dt>Model processing</dt>
                <dd>
                  {source.modelProcessing} · {source.modelInputReviewStatus}
                </dd>
              </div>
            </dl>
          )}

          <fieldset>
            <legend>Analysis route</legend>
            <label className={styles.radio}>
              <input
                checked={mode === "manual"}
                name="analysis-mode"
                onChange={() => setMode("manual")}
                type="radio"
              />
              <span>
                <strong>Parser / exact text for manual review</strong>
                Available only when stored studio sharing is permitted.
              </span>
            </label>
            <label className={styles.radio}>
              <input
                checked={mode === "gemini"}
                name="analysis-mode"
                onChange={() => setMode("gemini")}
                type="radio"
              />
              <span>
                <strong>Gemini candidate analysis</strong>
                Requires stored model permission and a cleared model-input
                review. The browser cannot grant either.
              </span>
            </label>
          </fieldset>

          <button
            className="button"
            disabled={busy || !source}
            type="submit"
          >
            {busy ? "Analyzing exact source…" : "Run source analysis"}
          </button>
        </form>

        <div className={styles.history}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Persisted analysis</h2>
            </div>
            <span>{data?.runs.length ?? 0} runs</span>
          </div>
          {(data?.runs.length ?? 0) === 0 ? (
            <p className={styles.empty}>
              No admitted-source analysis runs are available in the active
              provider grant scope.
            </p>
          ) : (
            <>
              <label htmlFor="source-analysis-run">Run to review</label>
              <select
                id="source-analysis-run"
                value={selectedRun?.locator ?? ""}
                onChange={(event) => setSelectedRunLocator(event.target.value)}
              >
                {data?.runs.map((run) => (
                  <option key={run.locator} value={run.locator}>
                    {run.sourceDisplayReference} · {runStatus(run.status)}
                  </option>
                ))}
              </select>
              {selectedRun && <RunCard run={selectedRun} />}
              <form className={styles.reviewForm} onSubmit={review}>
                <h3>Append provider review</h3>
                <label htmlFor="source-analysis-disposition">Disposition</label>
                <select
                  id="source-analysis-disposition"
                  value={reviewDisposition}
                  onChange={(event) => setReviewDisposition(
                    event.target.value as typeof reviewDisposition,
                  )}
                >
                  <option value="manual">Manual context reviewed</option>
                  <option value="accept">Accept candidate basis</option>
                  <option value="edit">Edit required</option>
                  <option value="reject">Reject candidate basis</option>
                </select>
                <label htmlFor="source-analysis-note">Review note</label>
                <textarea
                  id="source-analysis-note"
                  maxLength={2_000}
                  onChange={(event) => setReviewNote(event.target.value)}
                  required
                  value={reviewNote}
                />
                <button
                  className="button"
                  disabled={reviewBusy || !selectedRun}
                  type="submit"
                >
                  {reviewBusy ? "Saving review…" : "Record append-only review"}
                </button>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

"use client";

import { useState } from "react";
import type {
  AnalysisCandidate,
  AnalysisEvidence,
  AnalysisResponse,
} from "./types";

const MAX_PDF_BYTES = 10_000_000;
const numberFormatter = new Intl.NumberFormat("en-US");

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
  return value !== null
    && typeof value === "object"
    && "ok" in value
    && typeof value.ok === "boolean"
    && "manualFallback" in value;
}

function EvidenceQuote({ evidence }: { evidence: AnalysisEvidence }) {
  return (
    <div>
      <p className="context-attribution">
        {evidence.polarity === "supporting"
          ? "Supporting exact quote"
          : "Charge-weakening exact quote"}
        <span aria-hidden="true">/</span>
        code points {numberFormatter.format(evidence.start)}-
        {numberFormatter.format(evidence.end)}
      </p>
      <blockquote>&ldquo;{evidence.quote}&rdquo;</blockquote>
    </div>
  );
}

function CandidateReview({
  candidate,
  index,
}: {
  candidate: AnalysisCandidate;
  index: number;
}) {
  return (
    <details className="record-details" open={index === 0}>
      <summary>
        Candidate {numberFormatter.format(index + 1)}: {candidate.claimId}
      </summary>
      <div className="details-content">
        <p>
          <strong>Interpretation:</strong> {candidate.interpretation}
        </p>
        <p>
          <strong>Uncertainty ({candidate.uncertainty.status}):</strong>{" "}
          {candidate.uncertainty.explanation}
        </p>
        {candidate.uncertainty.questions.length > 0 && (
          <div>
            <strong>Questions for human review:</strong>
            <ul>
              {candidate.uncertainty.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        )}
        {candidate.evidence.map((evidence, evidenceIndex) => (
          <EvidenceQuote
            evidence={evidence}
            key={`${candidate.claimId}-${evidence.polarity}-${evidenceIndex}`}
          />
        ))}
        <p className="coverage-note">
          Human review is required. This candidate is not eligible for
          publication.
        </p>
      </div>
    </details>
  );
}

export default function AnalysisUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [contentAttested, setContentAttested] = useState(false);
  const [geminiPermitted, setGeminiPermitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState("");
  const [response, setResponse] = useState<AnalysisResponse | null>(null);

  const parser = response && "parser" in response
    ? response.parser
    : undefined;
  const model = response && "model" in response
    ? response.model
    : undefined;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError("");
    setResponse(null);
    if (!file) {
      setClientError("Choose one PDF before starting extraction.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setClientError("The PDF must be 10 MB or smaller.");
      return;
    }
    if (!contentAttested) {
      setClientError(
        "Confirm that the PDF is synthetic or permitted for this review.",
      );
      return;
    }

    const body = new FormData();
    body.set("file", file);
    body.set("contentAttested", "true");
    body.set("geminiPermitted", geminiPermitted ? "true" : "false");
    setSubmitting(true);
    try {
      const result = await fetch("/api/analysis", {
        method: "POST",
        body,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await result.json();
      if (!isAnalysisResponse(payload)) {
        throw new Error("INVALID_RESPONSE");
      }
      setResponse(payload);
    } catch {
      setClientError(
        "The analysis response could not be read. The PDF was not persisted; retry or use manual review.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="project-line">
        <span className="project-label">Workspace</span>
        <span>Protected provider analysis</span>
      </div>

      <nav className="section-nav" aria-label="On this page">
        <a href="#analysis-upload"><span aria-hidden="true">01</span>Upload</a>
        <a href="#analysis-extraction"><span aria-hidden="true">02</span>Extraction</a>
        <a href="#analysis-candidates"><span aria-hidden="true">03</span>Candidates</a>
        <a href="#analysis-boundaries"><span aria-hidden="true">04</span>Boundaries</a>
      </nav>

      <main id="analysis-main">
        <div className="page-intro">
          <h1>Review a provider PDF</h1>
          <p className="version-line">
            Isolated extraction <span aria-hidden="true">/</span> optional
            Gemini candidates
          </p>
          <p className="intro-copy">
            Upload one synthetic or permitted PDF. Extraction runs first in an
            isolated parser. Gemini processing is a separate opt-in and never
            replaces provider review.
          </p>
        </div>

        <aside className="included-note" aria-labelledby="analysis-note-title">
          <svg
            aria-hidden="true"
            className="info-icon"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 10.5v6M12 7.5h.01" />
          </svg>
          <div>
            <h2 id="analysis-note-title">Manual review remains available</h2>
            <p>
              Leave Gemini processing unchecked to run the parser-only path.
              No upload or result is persisted by this workstream.
            </p>
          </div>
        </aside>

        <section className="review-section" id="analysis-upload">
          <h2 className="section-heading">
            <span aria-hidden="true">01</span>
            <span>Upload and permissions</span>
          </h2>
          <div className="section-content">
            <form className="message-form" onSubmit={submit} noValidate>
              <div className="message-heading">
                <h3>Choose one PDF</h3>
                <span className="version-tag">Maximum 10 MB</span>
              </div>
              <p className="form-notice">
                Use no real customer documents. The server verifies your
                protected provider session again before reading the upload.
              </p>
              <label htmlFor="analysis-pdf">PDF document</label>
              <input
                accept=".pdf,application/pdf"
                id="analysis-pdf"
                name="analysis-pdf"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setClientError("");
                  setResponse(null);
                }}
                type="file"
              />
              <p className="field-help">
                {file
                  ? `${file.name} / ${numberFormatter.format(file.size)} bytes`
                  : "No file selected."}
              </p>
              <fieldset className="attestations">
                <legend className="sr-only">Upload attestations</legend>
                <label>
                  <input
                    checked={contentAttested}
                    onChange={(event) =>
                      setContentAttested(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    I attest that this PDF is synthetic or that I have explicit
                    permission to use its contents in this protected review.
                  </span>
                </label>
              </fieldset>
              <p className="sharing-note">
                <strong>Separate processing choice:</strong> extraction does
                not grant Gemini processing permission.
              </p>
              <label className="optional-consent">
                <input
                  checked={geminiPermitted}
                  onChange={(event) =>
                    setGeminiPermitted(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  Allow the configured Gemini model to prepare untrusted
                  candidate interpretations from this attested PDF. Optional.
                </span>
              </label>
              {clientError && (
                <p className="field-error" role="alert">{clientError}</p>
              )}
              {response && !response.ok && (
                <p className="field-error" role="alert">
                  {response.message} Reference code: {response.code}.
                </p>
              )}
              <button
                className="button"
                disabled={!file || !contentAttested || submitting}
                type="submit"
              >
                {submitting
                  ? "Extracting PDF…"
                  : geminiPermitted
                    ? "Extract PDF and prepare candidates"
                    : "Extract PDF for manual review"}
              </button>
              <p className="action-note" aria-live="polite">
                {submitting
                  ? "The isolated parser is processing the upload."
                  : "Nothing is persisted. Publication remains blocked."}
              </p>
            </form>
          </div>
        </section>

        <section className="review-section" id="analysis-extraction">
          <h2 className="section-heading">
            <span aria-hidden="true">02</span>
            <span>Extracted source reference</span>
          </h2>
          <div className="section-content">
            {!parser ? (
              <p className="section-lead">
                Extraction details will appear after a permitted PDF is parsed.
              </p>
            ) : (
              <>
                <dl className="status-grid">
                  <div>
                    <dt>Declared pages</dt>
                    <dd>{numberFormatter.format(parser.declaredPageCount)}</dd>
                  </div>
                  <div>
                    <dt>Extracted pages</dt>
                    <dd>{numberFormatter.format(parser.extractedPageCount)}</dd>
                  </div>
                  <div>
                    <dt>Code points</dt>
                    <dd>{numberFormatter.format(parser.codePointCount)}</dd>
                  </div>
                  <div>
                    <dt>Extraction</dt>
                    <dd>{parser.extractionStatus}</dd>
                  </div>
                </dl>
                <dl className="terms-list">
                  <div>
                    <dt>Extractor reference</dt>
                    <dd>{parser.extractorReference}</dd>
                  </div>
                  <div>
                    <dt>Immutable source</dt>
                    <dd>
                      {parser.sourceReference.workspaceId}/
                      {parser.sourceReference.projectId}/
                      {parser.sourceReference.sourceId}/
                      {parser.sourceReference.versionId}
                    </dd>
                  </div>
                </dl>
                <details className="record-details">
                  <summary>Page range references</summary>
                  <div className="details-content">
                    <ul>
                      {parser.pages.map((page) => (
                        <li key={page.pageNumber}>
                          Page {numberFormatter.format(page.pageNumber)}: code
                          points {numberFormatter.format(page.start)}-
                          {numberFormatter.format(page.end)}
                        </li>
                      ))}
                    </ul>
                    {parser.unavailablePageNumbers.length > 0 && (
                      <p>
                        Unavailable pages:{" "}
                        {parser.unavailablePageNumbers
                          .map((page) => numberFormatter.format(page))
                          .join(", ")}.
                      </p>
                    )}
                  </div>
                </details>
              </>
            )}
          </div>
        </section>

        <section className="review-section" id="analysis-candidates">
          <h2 className="section-heading">
            <span aria-hidden="true">03</span>
            <span>Candidate interpretations</span>
          </h2>
          <div className="section-content">
            {!model && (
              <p className="section-lead">
                Candidate state will appear after extraction.
              </p>
            )}
            {model?.status === "not-requested" && (
              <aside className="included-note">
                <div>
                  <h2>Gemini processing was not requested</h2>
                  <p>
                    The parser result is available for manual provider review.
                  </p>
                </div>
              </aside>
            )}
            {model?.status === "failed" && (
              <aside className="included-note">
                <div>
                  <h2>Candidate processing did not complete</h2>
                  <p>
                    {response?.manualFallback.message} Reference code:{" "}
                    {model.code}.
                  </p>
                </div>
              </aside>
            )}
            {model?.status === "completed" && (
              <>
                <dl className="status-grid">
                  <div>
                    <dt>Review state</dt>
                    <dd>Human review required</dd>
                  </div>
                  <div>
                    <dt>Publication</dt>
                    <dd>Blocked</dd>
                  </div>
                  <div>
                    <dt>Candidates</dt>
                    <dd>{numberFormatter.format(model.candidates.length)}</dd>
                  </div>
                  <div>
                    <dt>Persistence</dt>
                    <dd>None</dd>
                  </div>
                </dl>
                {model.candidates.map((candidate, index) => (
                  <CandidateReview
                    candidate={candidate}
                    index={index}
                    key={candidate.claimId}
                  />
                ))}
                {model.missingContext.length > 0 && (
                  <details className="record-details" open>
                    <summary>Missing context declared by the candidate</summary>
                    <div className="details-content">
                      <ul>
                        {model.missingContext.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        </section>

        <section className="review-section" id="analysis-boundaries">
          <h2 className="section-heading">
            <span aria-hidden="true">04</span>
            <span>Review boundaries</span>
          </h2>
          <div className="section-content">
            <aside className="included-note">
              <div>
                <h2>A candidate is evidence for review, not a decision</h2>
                <ul>
                  <li>Exact quotes remain attached to their polarity.</li>
                  <li>Uncertainty remains visible to the provider.</li>
                  <li>Human review is always required.</li>
                  <li>Publication is always blocked in this workstream.</li>
                </ul>
              </div>
            </aside>
          </div>
        </section>
      </main>

      <footer className="page-footer">
        <div>
          <strong>Ephemeral provider review.</strong>
          <p>
            The upload and result are not persisted. Server credentials never
            enter the browser response.
          </p>
        </div>
      </footer>
    </div>
  );
}

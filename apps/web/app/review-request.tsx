"use client";

import { useEffect, useRef, useState } from "react";

type Preview = "approve" | "decline" | "decline-open" | "question" | "correction";
type MessageKind = "question" | "correction";
type ReviewProjection = {
  connected: true;
  unitId: string;
  currentVersion: number | null;
  acceptedVersion: number | null;
  readiness:
    | "awaiting-agreement"
    | "review-hold"
    | "awaiting-payment"
    | "awaiting-prerequisite"
    | "financial-recheck"
    | "ready";
  holds: { reason: string; concernId: string | null }[];
  workStartRecorded: boolean;
};
type AccessProjection = {
  verified: boolean;
  role?: "client-approver" | "payer";
};
type RecordedDecision = {
  ok: true;
  recorded: true;
  unitId: string;
  version: number;
  decision: "approve" | "decline";
  agreementStatus: "approved" | "declined";
  obligationCreated: boolean;
  paymentStatus: "not-initiated";
};
type DecisionFailure = {
  ok: false;
  code: string;
};

const TEXT_LIMIT = 10_000;
const limitError = "This field exceeds 10,000 Unicode code points. Shorten it before previewing; your text has been kept.";
const countFormatter = new Intl.NumberFormat("en-US");

const terms = [
  ["Price", "USD 300.00"],
  ["Tax", "No tax added"],
  ["Receiving studio", "Northstar Studio"],
  [
    "Delivery",
    "5 working days after approval, full completed payment, and receipt of required content.",
  ],
  [
    "Dependency",
    "The included layout is required for final delivery. Included work is not gated by this payment.",
  ],
] as const;

const sections = [
  ["changes", "What changed"],
  ["terms", "Exact terms"],
  ["context", "Why this changed"],
  ["decision", "Your decision"],
] as const;

async function fetchReviewProjection(): Promise<ReviewProjection | null> {
  const response = await fetch("/api/demo/review", { cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as ReviewProjection;
  return body.connected ? body : null;
}

async function fetchAccessProjection(): Promise<AccessProjection | null> {
  const response = await fetch("/api/access/session", { cache: "no-store" });
  if (!response.ok) return null;
  return response.json() as Promise<AccessProjection>;
}

function decisionErrorMessage(code: string): string {
  switch (code) {
    case "CLIENT_ACCESS_REQUIRED":
    case "CLIENT_APPROVER_REQUIRED":
    case "DECISION_NOT_AUTHORIZED":
      return "Verified local client-approver access is required to record this decision.";
    case "APPROVAL_AUTHORITY_REQUIRED":
      return "Confirm your authority before recording an approval.";
    case "DECISION_ALREADY_RECORDED":
      return "A terminal decision is already recorded for these exact terms. Refresh the review before continuing.";
    case "DECISION_STATE_CHANGED":
    case "DECISION_NOT_AVAILABLE":
      return "The recorded review state changed. Refresh and review the current terms before trying again.";
    case "INVALID_DECISION_INPUT":
      return "Both review acknowledgments must be explicit before this decision can be recorded.";
    default:
      return "The decision could not be recorded safely. Nothing was shown as successful.";
  }
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="info-icon">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v1" />
    </svg>
  );
}

function SectionHeading({ number, children }: { number: string; children: string }) {
  return (
    <h2 className="section-heading">
      <span aria-hidden="true">{number}</span>
      <span>{children}</span>
    </h2>
  );
}

export default function ReviewRequest() {
  const [responseRead, setResponseRead] = useState(false);
  const [hasAuthority, setHasAuthority] = useState(false);
  const [messageKind, setMessageKind] = useState<MessageKind | null>(null);
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("");
  const [allowModel, setAllowModel] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [projection, setProjection] = useState<ReviewProjection | null>(null);
  const [access, setAccess] = useState<AccessProjection | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [recordedDecision, setRecordedDecision] = useState<RecordedDecision | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const messageTriggerRef = useRef<HTMLButtonElement>(null);
  const sourceDetailsRef = useRef<HTMLDetailsElement>(null);
  const previousDetailsRef = useRef<HTMLDetailsElement>(null);
  const readyToPreview = responseRead && hasAuthority;
  const messageLength = Array.from(message).length;
  const sourceLength = Array.from(source).length;
  const messageTooLong = messageLength > TEXT_LIMIT;
  const sourceTooLong = messageKind === "correction" && sourceLength > TEXT_LIMIT;
  const messageIssue = messageError || (messageTooLong ? limitError : "");
  const sourceIssue = sourceTooLong ? limitError : "";
  const canRecord = Boolean(
    projection
    && access?.verified
    && access.role === "client-approver",
  );
  const terminalDecision = recordedDecision?.decision
    ?? (projection?.acceptedVersion ? "approve" : null);
  const decisionRecorded = terminalDecision !== null;

  useEffect(() => {
    if (preview && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
    }
  }, [preview]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetchReviewProjection().catch(() => null),
      fetchAccessProjection().catch(() => null),
    ]).then(([review, localAccess]) => {
      if (active) {
        if (review) setProjection(review);
        if (localAccess) setAccess(localAccess);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function recordDecision(decision: "approve" | "decline") {
    setRecording(true);
    setRecordError("");
    try {
      const response = await fetch("/api/demo/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          reviewedResponse: responseRead,
          authority: hasAuthority,
        }),
      });
      const body = await response.json() as RecordedDecision | DecisionFailure;
      if (!response.ok || !body.ok) {
        setRecordError(decisionErrorMessage(body.ok ? "" : body.code));
        return;
      }
      const refreshed = await fetchReviewProjection().catch(() => null);
      if (refreshed) {
        setProjection(refreshed);
      }
      setRecordedDecision(body);
      dialogRef.current?.close();
    } catch {
      setRecordError(decisionErrorMessage("DECISION_RECORDING_FAILED"));
    } finally {
      setRecording(false);
    }
  }

  function openDecisionPreview(decision: "approve" | "decline") {
    setRecordError("");
    setPreview(decision);
  }

  function showSource() {
    const details = sourceDetailsRef.current;
    if (details) {
      details.open = true;
      details.scrollIntoView({ block: "start" });
      details.querySelector("summary")?.focus();
    }
  }

  function showPreviousVersion() {
    const details = previousDetailsRef.current;
    if (details) {
      details.open = true;
      details.scrollIntoView({ block: "start" });
      details.querySelector("summary")?.focus();
    }
  }

  function openMessage(kind: MessageKind, trigger: HTMLButtonElement) {
    messageTriggerRef.current = trigger;
    setMessageKind(kind);
    setMessageError("");
    requestAnimationFrame(() => {
      messageRef.current?.scrollIntoView({ block: "center" });
      messageRef.current?.focus();
    });
  }

  function closeMessage() {
    setMessageKind(null);
    messageTriggerRef.current?.focus();
  }

  function previewMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim()) {
      setMessageError("Add a question or describe the missing context before previewing.");
      messageRef.current?.focus();
      return;
    }
    if (messageTooLong) {
      messageRef.current?.focus();
      return;
    }
    if (sourceTooLong) {
      sourceRef.current?.focus();
      return;
    }
    if (messageKind) setPreview(messageKind);
  }

  const previewTitles: Record<Preview, string> = {
    approve: "Approval preview",
    decline: "Decline preview",
    "decline-open": "Decline with concern open",
    question: "Question preview",
    correction: "Context correction preview",
  };

  return (
    <>
      <a className="skip-link" href="#main">Skip to review</a>
      <header className="site-header" id="top">
        <div className="header-inner">
          <a className="wordmark" href="#top" aria-label="ScopeLedger, top of review">
            ScopeLedger<span className="wordmark-dot" aria-hidden="true">.</span>
          </a>
          <span className="studio-name">Northstar Studio</span>
          <span className="prototype-label">
            {projection ? "PostgreSQL-backed demo" : "Synthetic prototype"}
          </span>
          <span className="role-label">Client review preview</span>
        </div>
      </header>

      <div className="prototype-notice">
        <p>
          {projection
            ? canRecord
              ? "Agreement facts are read from local PostgreSQL. A verified client approver can record an outcome only after previewing it; payment remains separate."
              : "Agreement facts are read from local PostgreSQL. Actions remain previews until local client-approver access is verified."
            : "Explore the review. Nothing here is sent, approved, or charged."}
        </p>
        {projection && !canRecord && (
          <a href="/access-demo">Verify local client access</a>
        )}
        <a href="#about-prototype">About this prototype</a>
      </div>

      <div className="page-shell">
        <div className="project-line">
          <span className="project-label">Project</span>
          <span>Cedar Roastery website</span>
        </div>

        <nav className="section-nav" aria-label="On this page">
          {sections.map(([id, label], index) => (
            <a href={`#${id}`} key={id}>
              <span aria-hidden="true">0{index + 1}</span>{label}
            </a>
          ))}
        </nav>

        <main id="main">
          <div className="page-intro">
            <h1>Review this request</h1>
            <p className="version-line">Unit U1 <span aria-hidden="true">/</span> Version 2</p>
            <p className="intro-copy">
              The studio reviewed the context you supplied.
              These revised terms need your decision.
            </p>
          </div>

          <aside className="included-note" aria-labelledby="included-heading">
            <InfoIcon />
            <div>
              <h2 id="included-heading">Included under existing terms</h2>
              <ul>
                <li>Mobile menu fix</li>
                <li>Reusable case-study layout</li>
              </ul>
              <p>These stay part of the existing agreement. Neither requires this additional payment.</p>
            </div>
          </aside>

          <section id="changes" className="review-section">
            <SectionHeading number="01">What changed</SectionHeading>
            <div className="section-content">
              <p className="section-lead">Your email clarified what was already included.</p>
              <dl className="change-summary">
                <div>
                  <dt><span className="change-key">Before</span>Version 1</dt>
                  <dd>
                    <p>Reusable layout + one populated case-study page</p>
                    <p className="change-detail"><span className="money">USD 450.00</span><span className="historical-label">Superseded; not actionable</span></p>
                  </dd>
                </div>
                <div>
                  <dt><span className="change-key">Your context</span>Accepted email</dt>
                  <dd>The reusable layout was included in the original agreement. Populating individual pages was not.</dd>
                </div>
                <div className="current-change">
                  <dt><span className="change-key">Now</span>Version 2</dt>
                  <dd>
                    <p>One populated case-study page using the included layout</p>
                    <p className="change-detail"><span className="money">USD 300.00</span><span>For your decision</span></p>
                  </dd>
                </div>
              </dl>
              <button className="text-button" onClick={showPreviousVersion}>
                View version 1 as a historical record <span aria-hidden="true">&rarr;</span>
              </button>
            </div>
          </section>

          <section id="terms" className="review-section">
            <SectionHeading number="02">Exact terms</SectionHeading>
            <div className="section-content">
              <div className="unit-title">
                <h3>One populated case-study page</h3>
                <span className="version-tag">U1 / v2</span>
              </div>
              <div className="scope-grid">
                <div><h4>Scope</h4><p>One page using the included reusable layout. You supply copy and assets.</p></div>
                <div><h4>Exclusions</h4><p>No custom photography, additional pages, or general site redesign.</p></div>
              </div>
              <dl className="terms-list">
                {terms.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd className={label === "Price" ? "money" : undefined}>{value}</dd>
                  </div>
                ))}
                <div>
                  <dt>Payment condition</dt>
                  <dd>Full payment through PayPal after approval of these exact terms. Approval alone does not authorize the additional work.</dd>
                </div>
              </dl>
            </div>
          </section>

          <section id="context" className="review-section">
            <SectionHeading number="03">Why this changed</SectionHeading>
            <div className="section-content">
              <div className="context-panel">
                <div className="source-excerpt">
                  <p className="context-attribution">Client-supplied email <span aria-hidden="true">/</span> 3 Nov 2026</p>
                  <blockquote>
                    &ldquo;The reusable case-study layout is included in the original agreement.
                    Populating individual case-study pages is not included.&rdquo;
                  </blockquote>
                </div>
                <div className="provider-response">
                  <span className="review-label">Provider reviewed</span>
                  <p>The layout belongs to existing terms. Populating one page remains additional work.</p>
                  <p className="response-reference">Layout concern C1 <span aria-hidden="true">/</span> Response R1</p>
                  <button className="text-button" onClick={showSource}>View source context <span aria-hidden="true">&rarr;</span></button>
                </div>
              </div>
              <p className="coverage-note">
                <strong>Context represented:</strong> the synthetic statement of work and the supplied email.
                No other project sources are represented in this prototype.
              </p>
              <details ref={sourceDetailsRef} className="record-details">
                <summary>Source context and review basis</summary>
                <div className="details-content">
                  <p><strong>Synthetic statement of work, version 1:</strong> the Home, About, Menu, and Contact pages and mobile layout fixes are included. Additional case-study layouts and pages were originally excluded.</p>
                  <p><strong>Synthetic accepted email, 3 Nov 2026:</strong> the reusable case-study layout is included; populating individual pages is not. Acceptance and applicability are fixture facts, not verified in-app consent. The email date alone does not establish precedence.</p>
                  <p><strong>Provider response R1:</strong> recognize the layout under existing terms and reissue U1 as version 2 for the populated page only. This response does not itself resolve your concern.</p>
                  <p>No AI analysis, original document verification, or financial operation has run in this prototype.</p>
                </div>
              </details>
              <details ref={previousDetailsRef} className="record-details">
                <summary>Version 1 - historical, not actionable</summary>
                <div className="details-content">
                  <p><strong>Unit U1, version 1:</strong> reusable case-study layout (USD 150.00) and one populated page (USD 300.00), proposed together at USD 450.00 with no tax added.</p>
                  <p>The accepted email was not in the original review. This proposal is superseded. There is no decision or payment action for version 1.</p>
                  <p>Delivery was five working days after approval, full completed payment, and receipt of required content. Copy and assets were client-supplied; custom photography, additional pages, and site redesign were excluded.</p>
                  <a href="#terms">Return to the current version 2 terms</a>
                </div>
              </details>
            </div>
          </section>

          <section id="decision" className="review-section decision-section">
            <SectionHeading number="04">Your decision on version 2</SectionHeading>
            <div className="section-content">
              <dl className="status-grid">
                <div>
                  <dt>Agreement</dt>
                  <dd>
                    {terminalDecision === "approve"
                      ? "Approved"
                      : terminalDecision === "decline"
                        ? "Declined"
                        : "Awaiting decision"}
                    <span className="quiet">
                      {" / v"}
                      {projection?.currentVersion ?? 2}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Payment</dt>
                  <dd>
                    {terminalDecision === "decline"
                      ? "Not initiated"
                      : projection?.readiness === "ready"
                        ? "Verified"
                        : projection?.acceptedVersion
                          ? "Awaiting payment"
                          : "Unavailable until approval"}
                  </dd>
                </div>
                <div>
                  <dt>Additional work</dt>
                  <dd>
                    {projection?.readiness === "ready" ? "Ready" : "On hold"}
                    <span className="status-reason">
                      {terminalDecision === "decline"
                        ? "Offer declined; no payment initiated"
                        : projection?.readiness === "review-hold"
                          ? "Client concern requires exact decision"
                          : projection?.acceptedVersion
                            ? "Payment or prerequisites required"
                            : "Decision and payment required"}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Work start</dt>
                  <dd>
                    {projection?.workStartRecorded ? "Recorded" : "Not recorded"}
                  </dd>
                </div>
              </dl>
              {recordedDecision && (
                <p className="action-note" role="status">
                  {recordedDecision.decision === "approve"
                    ? `Approval recorded for ${recordedDecision.unitId}, version ${recordedDecision.version}. The agreement and payment obligation now exist; no payment was initiated.`
                    : `Decline recorded for ${recordedDecision.unitId}, version ${recordedDecision.version}. No agreement, obligation, or payment was created.`}
                </p>
              )}
              <div className="decision-intro">
                <h3>You are reviewing Unit U1, version 2.</h3>
                <p>
                  {decisionRecorded
                    ? terminalDecision === "approve"
                      ? "Version 2 is approved and the identified layout concern response is resolved. Payment remains a separate action."
                      : "Version 2 is declined and the identified layout concern response is resolved. No payment is available."
                    : "Layout concern C1 is awaiting your decision on response R1. A resolve-and-decide action would clear only that concern; other holds would still apply."}
                </p>
              </div>
              <fieldset className="attestations" disabled={decisionRecorded}>
                <legend className="sr-only">Review and authority acknowledgments</legend>
                <label>
                  <input type="checkbox" checked={responseRead} onChange={(event) => setResponseRead(event.target.checked)} />
                  <span>I have read the studio response to my layout concern (C1, response R1) and the current terms (U1 v2).</span>
                </label>
                <label>
                  <input type="checkbox" checked={hasAuthority} onChange={(event) => setHasAuthority(event.target.checked)} />
                  <span>I am authorized to decide for Cedar Roastery.</span>
                </label>
              </fieldset>
              <div className="decision-actions">
                <button className="button decision-button" disabled={!readyToPreview || decisionRecorded} onClick={() => openDecisionPreview("approve")}>
                  Resolve concern and approve these terms
                </button>
                <button className="button decision-button" disabled={!readyToPreview || decisionRecorded} onClick={() => openDecisionPreview("decline")}>
                  Resolve concern and decline this offer
                </button>
              </div>
              <p className="action-note" aria-live="polite">
                {decisionRecorded
                  ? `${terminalDecision === "approve" ? "An approval" : "A decline"} is recorded for version 2.`
                  : readyToPreview
                    ? canRecord
                      ? "Both acknowledgments are checked. Preview an outcome, then explicitly record it. Recording approval does not initiate payment."
                      : "Both acknowledgments are checked. You can preview either outcome; verified local client-approver access is required to record it."
                    : "Read the response and confirm your authority to preview a resolve-and-decide outcome."}
              </p>
              <div className="alternative-actions">
                <button className="text-button" onClick={(event) => openMessage("question", event.currentTarget)}>Ask a question</button>
                <button className="text-button" onClick={(event) => openMessage("correction", event.currentTarget)}>I believe this was already agreed</button>
                <button className="text-button" disabled={decisionRecorded} onClick={() => setPreview("decline-open")}>Decline and keep my concern open</button>
              </div>

              {messageKind && (
                <form className="message-form" onSubmit={previewMessage} noValidate>
                  <div className="message-heading">
                    <h3>{messageKind === "question" ? "Ask the studio a question" : "Supply missing agreement context"}</h3>
                    <button className="text-button" type="button" onClick={closeMessage}>Close</button>
                  </div>
                  <p className="form-notice">Use synthetic text only. Your draft stays in this tab, is not saved to a server, and is never sent. It will be lost on refresh.</p>
                  <label htmlFor="client-message">{messageKind === "question" ? "Your question" : "What do you believe was already agreed?"}</label>
                  <textarea id="client-message" name="message" autoComplete="off" ref={messageRef} rows={4} value={message} onChange={(event) => { setMessage(event.target.value); setMessageError(""); }} aria-invalid={Boolean(messageIssue)} aria-describedby={`draft-note${messageIssue ? " message-error" : ""}`} />
                  {messageIssue && <p className="field-error" id="message-error" role="alert">{messageIssue}</p>}
                  <p id="draft-note" className="field-help">{countFormatter.format(messageLength)} / 10,000 characters, counted as Unicode code points. Attachments and exact dates are not required.</p>
                  {messageKind === "correction" && (
                    <>
                      <label htmlFor="source-context">Source or explanation <span className="quiet">(optional)</span></label>
                      <textarea id="source-context" name="source" autoComplete="off" ref={sourceRef} rows={2} value={source} onChange={(event) => setSource(event.target.value)} aria-invalid={Boolean(sourceIssue)} aria-describedby={`source-note${sourceIssue ? " source-error" : ""}`} />
                      {sourceIssue && <p className="field-error" id="source-error" role="alert">{sourceIssue}</p>}
                      <p id="source-note" className="field-help">{countFormatter.format(sourceLength)} / 10,000 characters, counted as Unicode code points. Leave this blank if the source is unavailable; no proof is required to raise a concern.</p>
                    </>
                  )}
                  <p className="sharing-note"><strong>Recipients in the full product:</strong> Northstar Studio&apos;s authorized project team. Sharing with the studio and permission for model processing are separate.</p>
                  <label className="optional-consent">
                    <input type="checkbox" checked={allowModel} onChange={(event) => setAllowModel(event.target.checked)} />
                    <span>Allow an approved model to help review this context. Optional; leaving this unchecked keeps the manual-review path.</span>
                  </label>
                  <button className="button" type="submit">Preview what would be shared</button>
                </form>
              )}
            </div>
          </section>
        </main>

        <footer className="page-footer" id="about-prototype">
          <div>
            <strong>A shared record, not an AI verdict.</strong>
            <p>
              {projection
                ? "Synthetic project and proposed terms backed by local PostgreSQL. Only a verified local client approver can record the displayed decision; payment remains a separate action."
                : "Synthetic project and proposed terms. No identity verification, consent recording, model processing, or payment integration is connected."}
            </p>
          </div>
          <button className="text-button" onClick={() => window.print()}>Print this review</button>
        </footer>
      </div>

      <dialog ref={dialogRef} className="preview-dialog" onClose={() => setPreview(null)} aria-labelledby="preview-title" aria-describedby="preview-disclaimer">
        {preview && (
          <>
            <div className="dialog-heading">
              <h2 id="preview-title">{previewTitles[preview]}</h2>
              <button className="icon-button" aria-label="Close preview" onClick={() => dialogRef.current?.close()}><span aria-hidden="true">&times;</span></button>
            </div>
            <p className="preview-disclaimer" id="preview-disclaimer">
              {(preview === "approve" || preview === "decline") && canRecord
                ? "Preview only. Nothing has been recorded yet. Use the explicit record action below to submit this exact outcome."
                : "Local prototype only. Nothing is approved, declined, sent, resolved, or charged."}
            </p>
            <p className="dialog-version">Unit U1 / Version 2 / Northstar Studio</p>
            {preview === "approve" && <p>This outcome approves the exact USD 300.00 terms and resolves the identified layout concern only. Recording it creates agreement and obligation state. Payment remains a separate, authorized next step; approval does not mean paid, work started, or delivery accepted.</p>}
            {preview === "decline" && <p>This outcome declines the version 2 offer and acknowledges the identified response to your layout concern. It does not approve scope, create a payment obligation, or initiate payment. Other holds remain.</p>}
            {preview === "decline-open" && <p>In the full product, this would decline the offer while leaving your concern open. It would not acknowledge the studio response, release correction holds, or undo existing agreements.</p>}
            {(preview === "question" || preview === "correction") && (
              <>
                <p><strong>Would be shared with:</strong> the authorized Northstar Studio project team.</p>
                <blockquote className="message-preview">{message}</blockquote>
                {preview === "correction" && <p className="source-preview"><strong>Source:</strong> {source.trim() ? source : "Unavailable; no attachment supplied."}</p>}
                <p><strong>Model permission:</strong> {allowModel ? "Optional processing permitted, subject to the approved service configuration." : "Not permitted. Manual review remains available."}</p>
                <p>Only an actual, authorized submission in the full product could create a review hold. This preview creates no record or hold.</p>
              </>
            )}
            {(preview === "approve" || preview === "decline") && canRecord && !decisionRecorded && (
              <button
                className="button"
                disabled={recording}
                onClick={() => void recordDecision(preview)}
              >
                {recording
                  ? "Recording…"
                  : preview === "approve"
                    ? "Record this approval"
                    : "Record this decline"}
              </button>
            )}
            {(preview === "approve" || preview === "decline") && projection && !canRecord && (
              <p className="field-help">This remains a preview until local client-approver access is verified.</p>
            )}
            {recordError && <p className="field-error" role="alert">{recordError}</p>}
            <button className="button dialog-return" onClick={() => dialogRef.current?.close()}>Return to review</button>
          </>
        )}
      </dialog>
    </>
  );
}

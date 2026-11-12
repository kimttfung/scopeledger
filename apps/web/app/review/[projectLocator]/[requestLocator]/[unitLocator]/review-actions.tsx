"use client";

import React, {
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ReviewProjection,
} from "../../../../api/review/service";

type Decision = "approve" | "decline";
type MessageKind = "question" | "correction";
type Preview =
  | Readonly<{ kind: "decision"; decision: Decision }>
  | Readonly<{ kind: "message"; messageKind: MessageKind }>;

type MutationSuccess =
  | Readonly<{
    ok: true;
    kind: "decision";
    decision: Decision;
    obligationCreated: boolean;
    paymentChanged: false;
  }>
  | Readonly<{
    ok: true;
    kind: "question";
    duplicate: boolean;
    communicationEffect: "communication-only";
    reviewHoldCreated: false;
  }>
  | Readonly<{
    ok: true;
    kind: "correction";
    reviewStatus: "on-hold";
    reviewHoldCreated: true;
  }>;

type MutationFailure = Readonly<{
  ok: false;
  code: string;
}>;

const TEXT_LIMIT = 10_000;
const countFormatter = new Intl.NumberFormat("en-US");

function mutationError(code: string): string {
  switch (code) {
    case "CLIENT_ACCESS_REQUIRED":
    case "CLIENT_APPROVER_REQUIRED":
    case "REVIEW_MUTATION_NOT_AUTHORIZED":
      return "Your verified client-approver access no longer authorizes this action. Reverify access, then reopen the current review.";
    case "REVIEW_MUTATION_ORIGIN_REQUIRED":
      return "This action must be submitted from the same ScopeLedger origin. No record was created.";
    case "EXACT_VERSION_ACKNOWLEDGEMENT_REQUIRED":
      return "Confirm that you reviewed this exact published version before continuing.";
    case "APPROVAL_AUTHORITY_REQUIRED":
      return "Confirm your authority before recording an approval.";
    case "RESPONSE_ACKNOWLEDGEMENT_REQUIRED":
      return "Acknowledge the published correction response before recording this decision.";
    case "REVIEW_TEXT_LIMIT":
      return "The text exceeds 10,000 Unicode code points. Shorten it and preview again.";
    case "INVALID_REVIEW_MUTATION":
      return "The submitted action was incomplete or invalid. Review the fields and try again.";
    case "REVIEW_DECISION_ALREADY_RECORDED":
      return "A terminal decision is already recorded for these exact terms. Reload the current record.";
    case "REVIEW_MUTATION_CONFLICT":
      return "This verified session already submitted different content for this review. Reverify access before creating another record.";
    case "REVIEW_STATE_CHANGED":
    case "REVIEW_MUTATION_NOT_AVAILABLE":
      return "The published review changed. Nothing was recorded against the stale page; reload the current terms.";
    default:
      return "The action could not be recorded safely. No success is shown; retry after checking the current review.";
  }
}

export function ReviewActions({
  review,
  styles,
}: Readonly<{
  review: ReviewProjection;
  styles: Readonly<Record<string, string>>;
}>) {
  const [reviewedExactVersion, setReviewedExactVersion] = useState(false);
  const [authority, setAuthority] = useState(false);
  const [acknowledgedResponses, setAcknowledgedResponses] = useState(false);
  const [messageKind, setMessageKind] = useState<MessageKind | null>(null);
  const [text, setText] = useState("");
  const [allowModel, setAllowModel] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [recordChanged, setRecordChanged] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const responseCount =
    review.actions.decision.responseAcknowledgementCount;
  const responseReady = responseCount === 0 || acknowledgedResponses;
  const decisionReady = reviewedExactVersion && authority && responseReady;
  const textLength = Array.from(text).length;
  const textInvalid = text.trim().length === 0 || textLength > TEXT_LIMIT;

  useEffect(() => {
    if (preview && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
    }
  }, [preview]);

  function closePreview() {
    dialogRef.current?.close();
  }

  function openMessage(kind: MessageKind) {
    setMessageKind(kind);
    setText("");
    setAllowModel(false);
    setError("");
    setSuccess("");
    requestAnimationFrame(() => textRef.current?.focus());
  }

  function previewMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (text.trim().length === 0) {
      setError(
        messageKind === "question"
          ? "Enter the exact question you want recorded."
          : "Describe the agreement context you believe should be corrected.",
      );
      textRef.current?.focus();
      return;
    }
    if (textLength > TEXT_LIMIT) {
      setError(mutationError("REVIEW_TEXT_LIMIT"));
      textRef.current?.focus();
      return;
    }
    if (messageKind) {
      setPreview({ kind: "message", messageKind });
    }
  }

  async function submitMutation(body: object): Promise<void> {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(review.actions.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as
        | MutationSuccess
        | MutationFailure;
      if (!response.ok || !result.ok) {
        setError(mutationError(result.ok ? "" : result.code));
        return;
      }
      if (result.kind === "decision") {
        setSuccess(
          result.decision === "approve"
            ? result.obligationCreated
              ? "Approval recorded for these exact terms. An obligation exists, but payment was not initiated or changed."
              : "Approval recorded for these exact terms. No payment was initiated or changed."
            : "Decline recorded for these exact terms. No payment was initiated or changed.",
        );
        setRecordChanged(true);
      } else if (result.kind === "question") {
        setSuccess(
          result.duplicate
            ? "This exact question was already recorded by the current verified session. No review hold or commercial state change was created."
            : "Question recorded as communication only. No review hold, agreement, payment, readiness, or work-start fact changed.",
        );
        setMessageKind(null);
      } else {
        setSuccess(
          "Correction recorded and the current unit was placed on review hold. Agreement, payment, and work-start facts were not changed.",
        );
        setRecordChanged(true);
        setMessageKind(null);
      }
      closePreview();
    } catch {
      setError(mutationError("REVIEW_MUTATION_FAILED"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.actionSection} id="actions">
      <div className={styles.actionHeading}>
        <div>
          <h2>Record your response</h2>
          <p>
            Every action is previewed before submission and is bound to this
            server-verified published version.
          </p>
        </div>
        <span>Payment unavailable here</span>
      </div>

      <div
        className={styles.actionStatus}
        aria-live="polite"
        aria-atomic="true"
      >
        {success && <p className={styles.success}>{success}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {recordChanged && (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload the current record
          </button>
        )}
      </div>

      <div className={styles.actionColumns}>
        <div className={styles.decisionPanel}>
          <h3>Approve or decline</h3>
          {review.actions.decision.available && !recordChanged
            ? (
              <>
                <fieldset className={styles.acknowledgements}>
                  <legend>Required acknowledgements</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewedExactVersion}
                      onChange={(event) =>
                        setReviewedExactVersion(event.target.checked)}
                    />
                    <span>
                      I reviewed version {review.unit.version}, including its
                      exact scope, exclusions, rationale, timing, and commercial
                      terms.
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={authority}
                      onChange={(event) =>
                        setAuthority(event.target.checked)}
                    />
                    <span>
                      I am authorized to decide for this project.
                    </span>
                  </label>
                  {responseCount > 0 && (
                    <label>
                      <input
                        type="checkbox"
                        checked={acknowledgedResponses}
                        onChange={(event) =>
                          setAcknowledgedResponses(event.target.checked)}
                      />
                      <span>
                        I reviewed the published rationale and{" "}
                        {responseCount} current correction{" "}
                        {responseCount === 1 ? "response" : "responses"}{" "}
                        identified by this version.
                      </span>
                    </label>
                  )}
                </fieldset>
                <div className={styles.decisionButtons}>
                  <button
                    className={styles.primaryButton}
                    type="button"
                    disabled={!decisionReady}
                    onClick={() => {
                      setError("");
                      setPreview({
                        kind: "decision",
                        decision: "approve",
                      });
                    }}
                  >
                    Preview approval
                  </button>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    disabled={!decisionReady}
                    onClick={() => {
                      setError("");
                      setPreview({
                        kind: "decision",
                        decision: "decline",
                      });
                    }}
                  >
                    Preview decline
                  </button>
                </div>
                <p className={styles.actionNote}>
                  Approval may create an obligation for payable work. It never
                  initiates payment, records payment success, or proves work
                  started.
                </p>
              </>
            )
            : (
              <p className={styles.terminalNotice}>
                A terminal decision is already recorded for this exact
                published version. It cannot be replaced from this page.
              </p>
            )}
        </div>

        <div className={styles.messagePanel}>
          <h3>Ask or correct</h3>
          {!recordChanged && !messageKind && (
            <div className={styles.messageChoices}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => openMessage("question")}
              >
                Ask a question
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => openMessage("correction")}
              >
                Submit a context correction
              </button>
            </div>
          )}
          {!recordChanged && messageKind && (
            <form
              className={styles.messageForm}
              onSubmit={previewMessage}
              noValidate
            >
              <div className={styles.messageFormHeading}>
                <strong>
                  {messageKind === "question"
                    ? "Exact question"
                    : "Exact correction"}
                </strong>
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={() => setMessageKind(null)}
                >
                  Close
                </button>
              </div>
              <label htmlFor="review-message">
                {messageKind === "question"
                  ? "What do you want to ask?"
                  : "What agreement context should be corrected?"}
              </label>
              <textarea
                id="review-message"
                ref={textRef}
                rows={5}
                value={text}
                maxLength={20_000}
                aria-invalid={textLength > TEXT_LIMIT}
                aria-describedby="review-message-help"
                onChange={(event) => {
                  setText(event.target.value);
                  setError("");
                }}
              />
              <p id="review-message-help" className={styles.fieldHelp}>
                {countFormatter.format(textLength)} / 10,000 Unicode code
                points. Text is preserved exactly.
              </p>
              <label className={styles.modelPermission}>
                <input
                  type="checkbox"
                  checked={allowModel}
                  onChange={(event) => setAllowModel(event.target.checked)}
                />
                <span>
                  Permit an approved model to help review this text. Optional;
                  leaving this unchecked keeps the manual-review path.
                </span>
              </label>
              <button
                className={styles.primaryButton}
                type="submit"
                disabled={textInvalid}
              >
                Preview submission
              </button>
              <p className={styles.actionNote}>
                {messageKind === "question"
                  ? "A question is communication only and creates no review hold."
                  : "A correction creates a review hold only for this unit. It does not change agreement or payment facts."}
              </p>
            </form>
          )}
        </div>
      </div>

      <div className={styles.paymentBoundary}>
        <strong>Payment remains separate</strong>
        <p>
          This review can record a decision, question, or correction only.
          Checkout, capture, reconciliation, and payment status changes are not
          available in this slice.
        </p>
      </div>

      <dialog
        ref={dialogRef}
        className={styles.previewDialog}
        aria-labelledby="review-preview-title"
        onClose={() => setPreview(null)}
      >
        {preview && (
          <>
            <div className={styles.previewHeading}>
              <h2 id="review-preview-title">
                {preview.kind === "decision"
                  ? preview.decision === "approve"
                    ? "Approval preview"
                    : "Decline preview"
                  : preview.messageKind === "question"
                    ? "Question preview"
                    : "Correction preview"}
              </h2>
              <button
                className={styles.textButton}
                type="button"
                onClick={closePreview}
              >
                Close
              </button>
            </div>
            <p className={styles.previewNotice}>
              Nothing has been recorded yet. The action below submits only the
              exact content shown in this preview.
            </p>
            <dl className={styles.previewIdentity}>
              <div>
                <dt>Unit</dt>
                <dd>{review.unit.title}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{review.unit.version}</dd>
              </div>
            </dl>
            {preview.kind === "decision"
              ? (
                <>
                  <p>
                    This will record a terminal{" "}
                    <strong>{preview.decision}</strong> decision for the exact
                    published version shown above.
                  </p>
                  <p>
                    {preview.decision === "approve"
                      ? "Approval may create the published obligation. It does not initiate or verify payment."
                      : "Declining creates no obligation and initiates no payment."}
                  </p>
                  <button
                    className={styles.primaryButton}
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitMutation({
                      kind: "decision",
                      decision: preview.decision,
                      reviewedExactVersion,
                      authority,
                      acknowledgedResponses,
                    })}
                  >
                    {submitting
                      ? "Recording…"
                      : `Record ${preview.decision}`}
                  </button>
                </>
              )
              : (
                <>
                  <blockquote className={styles.messagePreview}>
                    {text}
                  </blockquote>
                  <p>
                    <strong>Model permission:</strong>{" "}
                    {allowModel
                      ? "Permitted for approved review processing."
                      : "Denied; manual review remains available."}
                  </p>
                  <p>
                    {preview.messageKind === "question"
                      ? "This records communication only and creates no hold or commercial state change."
                      : "This creates one correction hold for the current unit. It does not rewrite agreement, payment, or work-start facts."}
                  </p>
                  <button
                    className={styles.primaryButton}
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitMutation({
                      kind: preview.messageKind,
                      text,
                      allowModel,
                    })}
                  >
                    {submitting
                      ? "Submitting…"
                      : preview.messageKind === "question"
                        ? "Record question"
                        : "Record correction and hold"}
                  </button>
                </>
              )}
            {error && <p className={styles.error} role="alert">{error}</p>}
          </>
        )}
      </dialog>
    </section>
  );
}

"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AuthoringDraft } from "../../api/provider/authoring/service";
import type {
  CommercialPreparationPreview,
  CommercialPublication,
} from "../../api/provider/authoring/commercial-service";
import styles from "./authoring.module.css";

type CoverageDraft = Readonly<{
  sourceLocator: string;
  locator: string;
  materiality: "material" | "supporting";
  coverageStatus: "covered" | "unresolved";
  analysisStatus:
    | "not-used"
    | "human-reviewed"
    | "model-output-reviewed"
    | "unresolved";
  analysisReference: string;
  explanation: string;
}>;

type PreparedResponse = Readonly<{
  ok: true;
  preparation: CommercialPreparationPreview;
}>;

type PublishedResponse = Readonly<{
  ok: true;
  publication: CommercialPublication;
}>;

const moneyPattern = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

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
        : "Commercial preparation is unavailable.",
    );
  }
  return body as T;
}

function parsePrerequisites(value: string) {
  const parsed = lines(value).map((line) => {
    const [id, versionText, blocks, ...descriptionParts] =
      line.split("|").map((part) => part.trim());
    const version = Number(versionText);
    const description = descriptionParts.join(" | ").trim();
    if (
      !id
      || !identifierPattern.test(id)
      || !Number.isSafeInteger(version)
      || version < 1
      || !blocks
      || !["payment", "start", "payment-and-start"].includes(blocks)
      || !description
    ) {
      throw new Error(
        "Each prerequisite must use: id | version | payment, start, or payment-and-start | description.",
      );
    }
    return {
      id,
      version,
      blocks: blocks as "payment" | "start" | "payment-and-start",
      description,
    };
  });
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) {
    throw new Error("Prerequisite identifiers must be unique.");
  }
  return parsed;
}

function treatmentLabel(
  treatment: CommercialPreparationPreview["treatment"],
): string {
  switch (treatment) {
    case "included":
      return "Included under existing terms";
    case "waived":
      return "Additional work waived";
    case "payable":
      return "Payable additional work";
    default:
      return "Unresolved treatment";
  }
}

export default function CommercialWorkbench({
  projectId,
  requestId,
  unitId,
  draft,
  unitIds,
}: Readonly<{
  projectId: string;
  requestId: string;
  unitId: string;
  draft: AuthoringDraft;
  unitIds: readonly string[];
}>) {
  const [treatment, setTreatment] =
    useState<CommercialPreparationPreview["treatment"]>("unresolved");
  const [independenceExplanation, setIndependenceExplanation] = useState("");
  const [dependencySelection, setDependencySelection] =
    useState<Readonly<Record<string, boolean>>>({});
  const [dependencyExplanations, setDependencyExplanations] =
    useState<Readonly<Record<string, string>>>({});
  const [rationale, setRationale] = useState("");
  const [deliveryDescription, setDeliveryDescription] = useState("");
  const [deliveryDependencies, setDeliveryDependencies] = useState("");
  const [prerequisiteText, setPrerequisiteText] = useState("");
  const [waiverConsent, setWaiverConsent] =
    useState<"required" | "not-required">("required");
  const [paymentExplanation, setPaymentExplanation] = useState("");
  const [taxTreatment, setTaxTreatment] =
    useState<"none" | "exclusive" | "inclusive" | "not-applicable" | "unresolved">(
      "unresolved",
    );
  const [taxAmount, setTaxAmount] = useState("0.00");
  const [taxDeclaration, setTaxDeclaration] = useState("");
  const [priceDescription, setPriceDescription] = useState("");
  const [priceAmount, setPriceAmount] = useState("");
  const [coverage, setCoverage] = useState<readonly CoverageDraft[]>(
    () => draft.sourceReferences.map((source) => ({
      sourceLocator: source.locator,
      locator: "",
      materiality: "material",
      coverageStatus: "unresolved",
      analysisStatus: "unresolved",
      analysisReference: "",
      explanation: "",
    })),
  );
  const [preparation, setPreparation] =
    useState<CommercialPreparationPreview | null>(null);
  const [publication, setPublication] =
    useState<CommercialPublication | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const prepareKey = useRef<string | null>(null);
  const publishKey = useRef<string | null>(null);

  const otherUnits = useMemo(
    () => unitIds.filter((candidate) => candidate !== unitId),
    [unitId, unitIds],
  );

  function invalidate() {
    setPreparation(null);
    setPublication(null);
    setConfirmed(false);
    prepareKey.current = null;
    publishKey.current = null;
    setError(null);
    setMessage(null);
  }

  function chooseTreatment(
    next: CommercialPreparationPreview["treatment"],
  ) {
    invalidate();
    setTreatment(next);
    if (next === "payable") {
      setTaxTreatment("none");
      setTaxAmount("0.00");
    } else if (next === "unresolved") {
      setTaxTreatment("unresolved");
      setTaxAmount("0.00");
      setPriceAmount("");
      setPriceDescription("");
    } else {
      setTaxTreatment("not-applicable");
      setTaxAmount("0.00");
      setPriceAmount("");
      setPriceDescription("");
    }
  }

  function updateCoverage(
    index: number,
    update: Partial<CoverageDraft>,
  ) {
    invalidate();
    setCoverage((current) => current.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, ...update } : entry));
  }

  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (draft.state !== "ready-for-client-review") {
      setError(
        "Record a latest immutable revision as ready for client review before commercial preparation.",
      );
      return;
    }
    if (coverage.length === 0) {
      setError(
        "Commercial preparation requires at least one source on the exact draft revision.",
      );
      return;
    }
    const dependencies = otherUnits
      .filter((candidate) => dependencySelection[candidate])
      .map((candidate) => ({
        unitId: candidate,
        explanation: dependencyExplanations[candidate]?.trim() ?? "",
      }));
    if (dependencies.some((dependency) => !dependency.explanation)) {
      setError("Explain every selected dependency before preparing terms.");
      return;
    }
    if (
      coverage.some((entry) =>
        !entry.explanation.trim()
        || (
          entry.analysisStatus === "model-output-reviewed"
          && !entry.analysisReference.trim()
        )
        || (
          ["not-used", "unresolved"].includes(entry.analysisStatus)
          && entry.analysisReference.trim()
        ))
    ) {
      setError(
        "Complete each source explanation and match analysis references to the selected analysis status.",
      );
      return;
    }
    let prerequisites;
    try {
      prerequisites = parsePrerequisites(prerequisiteText);
    } catch (parseError) {
      setError(parseError instanceof Error
        ? parseError.message
        : "Prerequisites are invalid.");
      return;
    }
    if (
      !moneyPattern.test(taxAmount)
      || (
        treatment === "payable"
        && (!moneyPattern.test(priceAmount) || priceAmount === "0.00")
      )
    ) {
      setError("Price and tax amounts must use exact USD with two decimals.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      prepareKey.current ??= crypto.randomUUID();
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/drafts/${encodeURIComponent(unitId)}/commercial/prepare`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: prepareKey.current,
            draftRevision: draft.revision,
            treatment,
            independenceExplanation: independenceExplanation.trim(),
            dependencies,
            clientVisibleRationale: rationale.trim(),
            delivery: {
              description: deliveryDescription.trim(),
              dependencies: lines(deliveryDependencies),
            },
            prerequisites,
            consentRequirement: treatment === "payable"
              ? "required"
              : treatment === "waived"
                ? waiverConsent
                : "not-applicable",
            paymentExplanation: paymentExplanation.trim(),
            tax: {
              treatment: taxTreatment,
              amount: taxAmount,
              declaration: taxDeclaration.trim(),
            },
            price: treatment === "payable"
              ? {
                description: priceDescription.trim(),
                amount: priceAmount,
              }
              : null,
            sourceCoverage: coverage.map((entry) => ({
              ...entry,
              analysisReference: entry.analysisReference.trim() || null,
              explanation: entry.explanation.trim(),
            })),
          }),
        },
      );
      const body = await jsonResponse<PreparedResponse>(response);
      setPreparation(body.preparation);
      setPublication(null);
      setConfirmed(false);
      publishKey.current = null;
      setMessage(
        body.preparation.publicationAllowed
          ? "Prepared preview recorded. Nothing has been published."
          : "Prepared preview recorded with publication unavailable under the current treatment or coverage.",
      );
    } catch (preparationError) {
      setError(preparationError instanceof Error
        ? preparationError.message
        : "Commercial preparation could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  async function publishPrepared() {
    if (!preparation || !confirmed || !preparation.publicationAllowed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      publishKey.current ??= crypto.randomUUID();
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/drafts/${encodeURIComponent(unitId)}/commercial/publish`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: publishKey.current,
            draftRevision: draft.revision,
            preparationLocator: preparation.preparationLocator,
            confirmed: true,
          }),
        },
      );
      const body = await jsonResponse<PublishedResponse>(response);
      setPublication(body.publication);
      setMessage(
        "Immutable terms were published. No client decision, payment, or work readiness was created.",
      );
    } catch (publicationError) {
      setError(publicationError instanceof Error
        ? publicationError.message
        : "Prepared terms could not be published.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={styles.commercial}
      aria-labelledby="commercial-preparation-title"
    >
      <div className={styles.commercialHeading}>
        <div>
          <h2 id="commercial-preparation-title">Commercial preparation</h2>
          <p>
            Bind provider-reviewed treatment and exact terms to revision{" "}
            {draft.revision}. Preparation and publication are separate mutations.
          </p>
        </div>
        <span
          className={styles.readiness}
          data-ready={draft.state === "ready-for-client-review"}
        >
          {draft.state === "ready-for-client-review"
            ? "Draft review-ready"
            : "Draft still in progress"}
        </span>
      </div>

      <form className={styles.commercialForm} onSubmit={prepare}>
        <fieldset className={styles.fieldset} disabled={busy}>
          <legend>Treatment and unit basis</legend>
          <div className={styles.fieldGrid}>
            <div className={styles.fieldGroup}>
              <label htmlFor="commercial-treatment">Commercial treatment</label>
              <select
                className={styles.select}
                id="commercial-treatment"
                value={treatment}
                onChange={(event) =>
                  chooseTreatment(
                    event.target.value as CommercialPreparationPreview[
                      "treatment"
                    ],
                  )}
              >
                <option value="included">Included under existing terms</option>
                <option value="waived">Additional work waived</option>
                <option value="payable">Payable additional work</option>
                <option value="unresolved">Unresolved</option>
              </select>
            </div>
            {treatment === "waived" && (
              <div className={styles.fieldGroup}>
                <label htmlFor="waiver-consent">Client consent for waiver</label>
                <select
                  className={styles.select}
                  id="waiver-consent"
                  value={waiverConsent}
                  onChange={(event) => {
                    invalidate();
                    setWaiverConsent(
                      event.target.value as "required" | "not-required",
                    );
                  }}
                >
                  <option value="required">Required</option>
                  <option value="not-required">Not required</option>
                </select>
              </div>
            )}
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor="independence-explanation">
              Unit and independence explanation
            </label>
            <textarea
              className={styles.textarea}
              id="independence-explanation"
              value={independenceExplanation}
              onChange={(event) => {
                invalidate();
                setIndependenceExplanation(event.target.value);
              }}
              maxLength={10_000}
              required
            />
          </div>
          {otherUnits.length > 0 && (
            <div className={styles.dependencyRegister}>
              <h3>Dependencies on other draft threads</h3>
              {otherUnits.map((candidate) => {
                const index = unitIds.indexOf(candidate) + 1;
                const selected = dependencySelection[candidate] === true;
                return (
                  <div className={styles.dependencyRow} key={candidate}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => {
                          invalidate();
                          setDependencySelection((current) => ({
                            ...current,
                            [candidate]: event.target.checked,
                          }));
                        }}
                      />
                      Draft thread {index}
                    </label>
                    <input
                      className={styles.input}
                      aria-label={`Dependency explanation for draft thread ${index}`}
                      value={dependencyExplanations[candidate] ?? ""}
                      onChange={(event) => {
                        invalidate();
                        setDependencyExplanations((current) => ({
                          ...current,
                          [candidate]: event.target.value,
                        }));
                      }}
                      disabled={!selected || busy}
                      maxLength={10_000}
                      required={selected}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>

        <fieldset className={styles.fieldset} disabled={busy}>
          <legend>Client-visible scope rationale and timing</legend>
          <div className={styles.scopePreview}>
            <div>
              <h3>Exact included scope</h3>
              <ul>{draft.scope.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div>
              <h3>Exact exclusions</h3>
              {draft.exclusions.length ? (
                <ul>
                  {draft.exclusions.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : <p>None recorded.</p>}
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor="client-rationale">Client-visible rationale</label>
            <textarea
              className={styles.textarea}
              id="client-rationale"
              value={rationale}
              onChange={(event) => {
                invalidate();
                setRationale(event.target.value);
              }}
              maxLength={10_000}
              required
            />
          </div>
          <div className={styles.fieldGrid}>
            <div className={styles.fieldGroup}>
              <label htmlFor="delivery-description">Delivery and timing</label>
              <textarea
                className={styles.textarea}
                id="delivery-description"
                value={deliveryDescription}
                onChange={(event) => {
                  invalidate();
                  setDeliveryDescription(event.target.value);
                }}
                maxLength={10_000}
                required
              />
            </div>
            <div className={styles.fieldGroup}>
              <label htmlFor="delivery-dependencies">
                Delivery dependencies
              </label>
              <textarea
                className={styles.textarea}
                id="delivery-dependencies"
                value={deliveryDependencies}
                onChange={(event) => {
                  invalidate();
                  setDeliveryDependencies(event.target.value);
                }}
                placeholder="One exact dependency per line"
                maxLength={10_000}
              />
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor="commercial-prerequisites">Prerequisites</label>
            <textarea
              className={styles.textarea}
              id="commercial-prerequisites"
              value={prerequisiteText}
              onChange={(event) => {
                invalidate();
                setPrerequisiteText(event.target.value);
              }}
              placeholder="approved-copy | 1 | start | Client supplies final approved copy."
              maxLength={10_000}
              aria-describedby="prerequisite-help"
            />
            <p className={styles.fieldHelp} id="prerequisite-help">
              Optional, one per line: identifier | version | payment, start, or
              payment-and-start | exact description.
            </p>
          </div>
        </fieldset>

        <fieldset className={styles.fieldset} disabled={busy}>
          <legend>Source and analysis coverage</legend>
          {coverage.length === 0 ? (
            <p className={styles.blockedNotice}>
              This revision has no source references. The publication foundation
              requires at least one exact source coverage record.
            </p>
          ) : (
            <ol className={styles.coverageList}>
              {coverage.map((entry, index) => {
                const source = draft.sourceReferences[index]!;
                return (
                  <li className={styles.coverageItem} key={entry.sourceLocator}>
                    <div className={styles.coverageHeading}>
                      <h3>{source.displayReference}</h3>
                      <span>Source {index + 1}</span>
                    </div>
                    <div className={styles.coverageGrid}>
                      <div className={styles.fieldGroup}>
                        <label htmlFor={`materiality-${index}`}>Materiality</label>
                        <select
                          className={styles.select}
                          id={`materiality-${index}`}
                          value={entry.materiality}
                          onChange={(event) => updateCoverage(index, {
                            materiality: event.target.value as CoverageDraft[
                              "materiality"
                            ],
                          })}
                        >
                          <option value="material">Material</option>
                          <option value="supporting">Supporting</option>
                        </select>
                      </div>
                      <div className={styles.fieldGroup}>
                        <label htmlFor={`coverage-status-${index}`}>
                          Coverage status
                        </label>
                        <select
                          className={styles.select}
                          id={`coverage-status-${index}`}
                          value={entry.coverageStatus}
                          onChange={(event) => updateCoverage(index, {
                            coverageStatus: event.target.value as CoverageDraft[
                              "coverageStatus"
                            ],
                          })}
                        >
                          <option value="covered">Covered</option>
                          <option value="unresolved">Unresolved</option>
                        </select>
                      </div>
                      <div className={styles.fieldGroup}>
                        <label htmlFor={`analysis-status-${index}`}>
                          Analysis status
                        </label>
                        <select
                          className={styles.select}
                          id={`analysis-status-${index}`}
                          value={entry.analysisStatus}
                          onChange={(event) => updateCoverage(index, {
                            analysisStatus: event.target.value as CoverageDraft[
                              "analysisStatus"
                            ],
                            analysisReference: "",
                          })}
                        >
                          <option value="not-used">Not used</option>
                          <option value="human-reviewed">Human reviewed</option>
                          <option value="model-output-reviewed">
                            Model output reviewed
                          </option>
                          <option value="unresolved">Unresolved</option>
                        </select>
                      </div>
                    </div>
                    <div className={styles.fieldGroup}>
                      <label htmlFor={`coverage-locator-${index}`}>
                        Client-visible source locator
                      </label>
                      <input
                        className={styles.input}
                        id={`coverage-locator-${index}`}
                        value={entry.locator}
                        onChange={(event) => updateCoverage(index, {
                          locator: event.target.value,
                        })}
                        placeholder="Agreement section 4.2"
                        maxLength={10_000}
                        required
                      />
                    </div>
                    {(entry.analysisStatus === "human-reviewed"
                      || entry.analysisStatus === "model-output-reviewed") && (
                      <div className={styles.fieldGroup}>
                        <label htmlFor={`analysis-reference-${index}`}>
                          Analysis reference
                          {entry.analysisStatus === "human-reviewed" && (
                            <span className={styles.optional}> optional</span>
                          )}
                        </label>
                        <input
                          className={styles.input}
                          id={`analysis-reference-${index}`}
                          value={entry.analysisReference}
                          onChange={(event) => updateCoverage(index, {
                            analysisReference: event.target.value,
                          })}
                          maxLength={2_000}
                          required={entry.analysisStatus === "model-output-reviewed"}
                        />
                      </div>
                    )}
                    <div className={styles.fieldGroup}>
                      <label htmlFor={`coverage-explanation-${index}`}>
                        Coverage explanation
                      </label>
                      <textarea
                        className={styles.textarea}
                        id={`coverage-explanation-${index}`}
                        value={entry.explanation}
                        onChange={(event) => updateCoverage(index, {
                          explanation: event.target.value,
                        })}
                        maxLength={10_000}
                        required
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </fieldset>

        <fieldset className={styles.fieldset} disabled={busy}>
          <legend>Tax, price, and payment terms</legend>
          {treatment === "payable" && (
            <div className={styles.fieldGrid}>
              <div className={styles.fieldGroup}>
                <label htmlFor="price-description">Exact price description</label>
                <input
                  className={styles.input}
                  id="price-description"
                  value={priceDescription}
                  onChange={(event) => {
                    invalidate();
                    setPriceDescription(event.target.value);
                  }}
                  maxLength={10_000}
                  required
                />
              </div>
              <div className={styles.fieldGroup}>
                <label htmlFor="price-amount">Exact USD price</label>
                <div className={styles.moneyInput}>
                  <span aria-hidden="true">$</span>
                  <input
                    className={styles.input}
                    id="price-amount"
                    inputMode="decimal"
                    value={priceAmount}
                    onChange={(event) => {
                      invalidate();
                      setPriceAmount(event.target.value);
                    }}
                    placeholder="300.00"
                    pattern="(0|[1-9][0-9]{0,9})\.[0-9]{2}"
                    required
                  />
                </div>
              </div>
            </div>
          )}
          <div className={styles.fieldGrid}>
            <div className={styles.fieldGroup}>
              <label htmlFor="tax-treatment">Tax treatment</label>
              <select
                className={styles.select}
                id="tax-treatment"
                value={taxTreatment}
                onChange={(event) => {
                  invalidate();
                  setTaxTreatment(
                    event.target.value as typeof taxTreatment,
                  );
                }}
                disabled={treatment !== "payable" || busy}
              >
                {treatment === "payable" ? (
                  <>
                    <option value="none">No tax added</option>
                    <option value="exclusive">Tax added to price</option>
                    <option value="inclusive">Tax included in price</option>
                  </>
                ) : treatment === "unresolved" ? (
                  <option value="unresolved">Unresolved</option>
                ) : (
                  <option value="not-applicable">Not applicable</option>
                )}
              </select>
            </div>
            <div className={styles.fieldGroup}>
              <label htmlFor="tax-amount">Exact tax amount</label>
              <input
                className={styles.input}
                id="tax-amount"
                inputMode="decimal"
                value={taxAmount}
                onChange={(event) => {
                  invalidate();
                  setTaxAmount(event.target.value);
                }}
                disabled={treatment !== "payable" || busy}
                pattern="(0|[1-9][0-9]{0,9})\.[0-9]{2}"
                required
              />
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor="tax-declaration">Explicit tax declaration</label>
            <textarea
              className={styles.textarea}
              id="tax-declaration"
              value={taxDeclaration}
              onChange={(event) => {
                invalidate();
                setTaxDeclaration(event.target.value);
              }}
              maxLength={10_000}
              required
            />
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor="payment-explanation">Payment terms</label>
            <textarea
              className={styles.textarea}
              id="payment-explanation"
              value={paymentExplanation}
              onChange={(event) => {
                invalidate();
                setPaymentExplanation(event.target.value);
              }}
              maxLength={10_000}
              required
            />
            <p className={styles.fieldHelp}>
              Payable publication uses the existing full-prepayment policy.
              Preparation and publication never create a payment attempt.
            </p>
          </div>
        </fieldset>

        <div className={styles.buttonRow}>
          <button
            className="button"
            type="submit"
            disabled={
              busy
              || draft.state !== "ready-for-client-review"
              || coverage.length === 0
              || !independenceExplanation.trim()
              || !rationale.trim()
              || !deliveryDescription.trim()
              || !paymentExplanation.trim()
              || !taxDeclaration.trim()
              || (
                treatment === "payable"
                && (!priceDescription.trim() || !priceAmount)
              )
            }
          >
            {busy ? "Preparing exact preview…" : "Prepare commercial preview"}
          </button>
        </div>
      </form>

      {preparation && (
        <section
          className={styles.preparationPreview}
          aria-labelledby="prepared-preview-title"
        >
          <div className={styles.previewHeading}>
            <div>
              <h2 id="prepared-preview-title">Prepared preview</h2>
              <p>
                Prepared {timestamp(preparation.preparedAt)} from immutable draft
                revision {preparation.draftRevision}. This is not publication.
              </p>
            </div>
            <span
              className={styles.readiness}
              data-ready={preparation.publicationAllowed}
            >
              {preparation.publicationAllowed
                ? "Eligible to publish"
                : preparation.publicationReadiness === "blocked"
                  ? "Publication blocked"
                  : "No client offer"}
            </span>
          </div>

          <div className={styles.previewLedger}>
            <div>
              <span>Treatment</span>
              <strong>{treatmentLabel(preparation.treatment)}</strong>
            </div>
            <div>
              <span>Exact draft</span>
              <strong>{preparation.draft.title}</strong>
            </div>
            <div>
              <span>Delivery</span>
              <strong>{preparation.terms.delivery.description}</strong>
            </div>
            <div>
              <span>Payment terms</span>
              <strong>{preparation.terms.paymentExplanation}</strong>
            </div>
            <div>
              <span>Tax declaration</span>
              <strong>
                {preparation.terms.tax.treatment} · USD{" "}
                {preparation.terms.tax.amount}
              </strong>
            </div>
            <div>
              <span>Price</span>
              <strong>
                {preparation.terms.price
                  ? `${preparation.terms.price.description} · ${
                    preparation.terms.price.currency
                  } ${preparation.terms.price.amount} price · ${
                    preparation.terms.price.currency
                  } ${preparation.terms.price.gross} gross`
                  : "No collectible amount"}
              </strong>
            </div>
          </div>

          <div className={styles.previewNarrative}>
            <div>
              <h3>Client-visible rationale</h3>
              <p>{preparation.terms.clientVisibleRationale}</p>
            </div>
            <div>
              <h3>Independent-unit basis</h3>
              <p>{preparation.terms.independenceExplanation}</p>
            </div>
            <div>
              <h3>Explicit tax declaration</h3>
              <p>{preparation.terms.tax.declaration}</p>
            </div>
          </div>

          <div className={styles.previewScope}>
            <div>
              <h3>Published scope</h3>
              <ul>
                {preparation.draft.scope.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
            <div>
              <h3>Published exclusions</h3>
              {preparation.draft.exclusions.length ? (
                <ul>
                  {preparation.draft.exclusions.map((item) =>
                    <li key={item}>{item}</li>)}
                </ul>
              ) : <p>None recorded.</p>}
            </div>
          </div>

          <div className={styles.previewLists}>
            <div>
              <h3>Unit dependencies</h3>
              {preparation.terms.dependencies.length ? (
                <ul>
                  {preparation.terms.dependencies.map((dependency) =>
                    <li key={dependency.explanation}>
                      {dependency.explanation}
                    </li>)}
                </ul>
              ) : <p>None recorded.</p>}
            </div>
            <div>
              <h3>Delivery dependencies</h3>
              {preparation.terms.delivery.dependencies.length ? (
                <ul>
                  {preparation.terms.delivery.dependencies.map((dependency) =>
                    <li key={dependency}>{dependency}</li>)}
                </ul>
              ) : <p>None recorded.</p>}
            </div>
            <div>
              <h3>Prerequisites</h3>
              {preparation.terms.prerequisites.length ? (
                <ul>
                  {preparation.terms.prerequisites.map((prerequisite) =>
                    <li key={prerequisite.id}>
                      {prerequisite.description} ({prerequisite.blocks})
                    </li>)}
                </ul>
              ) : <p>None recorded.</p>}
            </div>
          </div>

          <div className={styles.previewSources}>
            <h3>Source and analysis coverage</h3>
            <ol>
              {preparation.draft.sources.map((source) => (
                <li key={source.displayReference}>
                  <strong>{source.displayReference}</strong>
                  <span>{source.locator}</span>
                  <span>
                    {source.materiality} · {source.coverageStatus} ·{" "}
                    {source.analysisStatus}
                  </span>
                  <p>{source.explanation}</p>
                </li>
              ))}
            </ol>
          </div>

          <p className={styles.previewBoundary}>
            {preparation.treatment === "included"
              ? "Included treatment remains under existing terms and cannot be published as a new client offer."
              : preparation.treatment === "unresolved"
                ? "Unresolved treatment cannot be published. Resolve treatment and prepare a new exact preview."
                : preparation.publicationReadiness === "blocked"
                  ? "Material coverage or source permission blocks publication. Correct the source basis and prepare again."
                  : "Publishing will create only immutable client-reviewable terms. It will not record consent, create an obligation, dispatch payment, or mark work ready."}
          </p>

          {preparation.publicationAllowed && !publication && (
            <div className={styles.confirmPublication}>
              <label htmlFor="publication-confirmation">
                <input
                  id="publication-confirmation"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy}
                />
                I reviewed this exact prepared preview and intend to publish it
                for client review.
              </label>
              <button
                className="button"
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void publishPrepared()}
              >
                {busy ? "Publishing exact terms…" : "Publish exact prepared terms"}
              </button>
            </div>
          )}
        </section>
      )}

      {publication && (
        <section
          className={styles.publicationResult}
          aria-labelledby="publication-result-title"
        >
          <h2 id="publication-result-title">Terms published</h2>
          <p>
            Version {publication.version} was published{" "}
            {timestamp(publication.publishedAt)}. No decision or payment was
            created.
          </p>
          <Link className="button" href={publication.review.url}>
            Open protected client review
          </Link>
        </section>
      )}

      <p
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error ?? message ?? (busy ? "Re-reading protected commercial state…" : "")}
      </p>
    </section>
  );
}

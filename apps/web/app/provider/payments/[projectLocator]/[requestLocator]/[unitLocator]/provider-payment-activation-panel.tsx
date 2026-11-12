"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Activation = Readonly<{
  status: "ready" | "active";
  confirmationLocator: string;
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  amount: Readonly<{ currency: "USD"; gross: string }>;
  payer: Readonly<{
    label: "Fixed local demo payer";
    localChannelVerification: "separate";
  }>;
  authority: Readonly<{
    pay: true;
    inspect: false;
    decide: false;
    correct: false;
    publish: false;
    nominate: false;
  }>;
  obligationScope: "exact-approved-obligation";
  payerUrl: string | null;
  activatedAt: string | null;
}>;

type Success = Readonly<{
  ok: true;
  duplicate?: boolean;
  activation: Activation;
}>;
type Failure = Readonly<{ ok: false; code: string }>;

export function ProviderPaymentActivationPanel({
  endpoint,
}: Readonly<{ endpoint: string }>) {
  const [activation, setActivation] = useState<Activation | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as Success | Failure;
        if (!response.ok || !body.ok) {
          throw new Error(body.ok ? "" : body.code);
        }
        if (active) setActivation(body.activation);
      })
      .catch(() => {
        if (active) {
          setError("The exact approved payer activation preview is unavailable.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);

  async function activate() {
    if (!activation) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationLocator: activation.confirmationLocator,
          confirmed: true,
        }),
      });
      const body = await response.json() as Success | Failure;
      if (!response.ok || !body.ok) {
        throw new Error(body.ok ? "" : body.code);
      }
      setActivation(body.activation);
    } catch (activationError) {
      setError(paymentAuthorityError(
        activationError instanceof Error ? activationError.message : "",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="payment-return-panel">
      <h1>Activate payer authority</h1>
      {loading && <p>Loading the exact approved obligation…</p>}
      {activation && (
        <>
          <p>
            This is a separate provider action. Client approval, matching email,
            and browser role selection do not grant payer authority.
          </p>
          <dl>
            <dt>Project</dt>
            <dd>{activation.projectLabel}</dd>
            <dt>Request</dt>
            <dd>{activation.requestLabel}</dd>
            <dt>Approved unit</dt>
            <dd>{activation.unitTitle}</dd>
            <dt>Exact server amount</dt>
            <dd>{activation.amount.currency} {activation.amount.gross}</dd>
            <dt>Payer</dt>
            <dd>{activation.payer.label}</dd>
            <dt>Authority granted</dt>
            <dd>Pay this exact approved obligation only</dd>
            <dt>Approver authority</dt>
            <dd>None</dd>
          </dl>
          {activation.status === "ready"
            ? (
              <button
                className="button"
                type="button"
                disabled={submitting}
                onClick={() => void activate()}
              >
                {submitting
                  ? "Activating exact payer authority…"
                  : "Activate fixed local payer"}
              </button>
            )
            : (
              <div className="payment-return-status">
                <strong>Payer authority active</strong>
                <p>
                  The opaque payer URL contains no workspace, project, unit,
                  obligation, amount, merchant, Order, or capture identifier.
                </p>
                {activation.payerUrl && (
                  <Link
                    className="button"
                    href={activation.payerUrl}
                    prefetch={false}
                  >
                    Open opaque payer Checkout
                  </Link>
                )}
              </div>
            )}
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="payment-return-actions">
        <Link className="button" href="/provider/payments">
          Return to payer authority
        </Link>
      </div>
    </section>
  );
}

function paymentAuthorityError(code: string): string {
  switch (code) {
    case "SAME_ORIGIN_REQUIRED":
      return "The browser did not provide same-origin request proof. Reload this ScopeLedger page before retrying.";
    case "PAYMENT_AUTHORITY_CHANGED":
      return "The approved obligation or authority basis changed. Reload the exact preview before retrying.";
    case "PROVIDER_PAYMENT_GRANT_REQUIRED":
    case "PROVIDER_ASSURANCE_REQUIRED":
      return "The current provider session no longer has the required protected authority.";
    default:
      return "Payer authority was not activated. Refresh the exact preview before retrying.";
  }
}

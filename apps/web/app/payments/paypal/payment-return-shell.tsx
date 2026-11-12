"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type PaymentReturnShellProps = {
  kind: "return" | "cancel";
};
type PaymentState =
  | "not-started"
  | "preparing"
  | "awaiting-buyer-approval"
  | "awaiting-capture"
  | "pending"
  | "completed"
  | "reconciliation-required";
type PaymentResponse = {
  ok: true;
  state: PaymentState;
  providerState?: "pending" | "unknown" | "completed";
  recovery?: "refresh-available" | "manual-recovery-required";
  readiness:
    | "awaiting-agreement"
    | "review-hold"
    | "awaiting-payment"
    | "awaiting-prerequisite"
    | "financial-recheck"
    | "ready";
};
type PaymentFailure = {
  ok: false;
  code: string;
  state?: PaymentState;
};

const content = {
  return: {
    title: "Back from PayPal",
    status: "Payment verification pending",
    description:
      "PayPal returned this browser to ScopeLedger. This redirect is not confirmation that payment completed.",
    detail:
      "ScopeLedger must verify the original Order and capture through its server-side payment worker before any payment condition or work readiness can change.",
  },
  cancel: {
    title: "PayPal approval was not completed here",
    status: "No payment result inferred",
    description:
      "Returning from or closing PayPal does not create, cancel, or complete a payment in ScopeLedger.",
    detail:
      "The original payment attempt must be checked server-side before another action is offered. No browser return can mark an agreement paid or ready.",
  },
} as const;

export default function PaymentReturnShell({
  kind,
}: PaymentReturnShellProps) {
  const copy = content[kind];
  const [payment, setPayment] = useState<PaymentResponse | null>(null);
  const [loading, setLoading] = useState(kind === "return");
  const [capturing, setCapturing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (kind !== "return") return;
    let active = true;
    void readStatus()
      .then((body) => {
        if (!active) return;
        setPayment(body);
      })
      .catch((statusError: unknown) => {
        if (active) setError(paymentError(requestErrorCode(statusError)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind]);

  async function captureAndVerify() {
    setCapturing(true);
    setError("");
    try {
      const response = await fetch("/api/demo/payment/capture", {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.json() as PaymentResponse | PaymentFailure;
      if (!response.ok || !body.ok) {
        setError(paymentError(body.ok ? "" : body.code));
        if (!body.ok && body.code === "PAYMENT_RECONCILIATION_REQUIRED") {
          try {
            setPayment(await readStatus());
          } catch (statusError: unknown) {
            setError(paymentError(requestErrorCode(statusError)));
          }
        }
        return;
      }
      setPayment(body);
    } catch {
      setError(paymentError("PAYMENT_SERVICE_UNAVAILABLE"));
    } finally {
      setCapturing(false);
    }
  }

  async function reconcileAndRefresh() {
    setReconciling(true);
    setError("");
    try {
      const response = await fetch("/api/demo/payment/reconcile", {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.json() as PaymentResponse | PaymentFailure;
      if (!response.ok || !body.ok) {
        setError(paymentError(body.ok ? "" : body.code));
        return;
      }
      setPayment(body);
    } catch {
      setError(paymentError("PAYMENT_SERVICE_UNAVAILABLE"));
    } finally {
      setReconciling(false);
    }
  }

  const canCapture = kind === "return"
    && (payment?.state === "awaiting-buyer-approval"
      || payment?.state === "awaiting-capture");
  const canReconcile = kind === "return"
    && payment !== null
    && payment.recovery !== "manual-recovery-required"
    && (
      payment.state === "pending"
      || payment.state === "completed"
      || payment.state === "reconciliation-required"
    );

  return (
    <>
      <a className="skip-link" href="#payment-return-main">
        Skip to payment status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Northstar Studio</span>
          <span className="prototype-label">Sandbox payment</span>
          <span className="role-label">Payer return</span>
        </div>
      </header>
      <div className="prototype-notice">
        Sandbox diagnostic only. This page does not record payment or authorize work.
      </div>
      <main className="payment-return-shell" id="payment-return-main">
        <section
          className="payment-return-panel"
          aria-labelledby="payment-return-title"
        >
          <h1 id="payment-return-title">{copy.title}</h1>
          <p className="payment-return-copy">{copy.description}</p>
          <div className="payment-return-status" role="status">
            <strong>
              {payment?.state === "completed"
                && payment.providerState !== "pending"
                && payment.providerState !== "unknown"
                ? "Payment verified"
                : copy.status}
            </strong>
            <p>{copy.detail}</p>
            {kind === "return" && (
              <p>
                {loading
                  ? "Reading the authoritative ScopeLedger payment state…"
                  : payment
                    ? `Ledger payment state: ${payment.state}. ${
                      payment.providerState
                        ? `Authoritative provider state: ${payment.providerState}. `
                        : ""
                    }Work readiness: ${payment.readiness}.`
                    : "No authoritative payment result is available in this browser view."}
              </p>
            )}
            {kind === "return"
              && payment?.recovery === "manual-recovery-required" && (
              <p>
                ScopeLedger could not identify exactly one matching capture under
                the original server-known Order. Manual recovery is required; no
                new attempt or capture was created.
              </p>
            )}
          </div>
          <div className="payment-return-actions">
            {canCapture && (
              <button
                className="button"
                disabled={capturing || reconciling}
                onClick={() => void captureAndVerify()}
              >
                {capturing
                  ? "Capturing and verifying…"
                  : "Capture and verify the original Order"}
              </button>
            )}
            {canReconcile && (
              <button
                className="button"
                disabled={capturing || reconciling}
                onClick={() => void reconcileAndRefresh()}
              >
                {reconciling
                  ? "Refreshing authoritative status…"
                  : "Recover the original capture status"}
              </button>
            )}
            <Link className="button" href="/">
              Return to request review
            </Link>
            {error && <p className="field-error" role="alert">{error}</p>}
          </div>
        </section>
      </main>
    </>
  );
}

async function readStatus(): Promise<PaymentResponse> {
  const response = await fetch("/api/demo/payment/status", {
    method: "POST",
    cache: "no-store",
  });
  const body = await response.json() as PaymentResponse | PaymentFailure;
  if (!response.ok || !body.ok) {
    throw new Error(body.ok ? "PAYMENT_SERVICE_UNAVAILABLE" : body.code);
  }
  return body;
}

function requestErrorCode(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "PAYMENT_SERVICE_UNAVAILABLE";
}

function paymentError(code: string): string {
  switch (code) {
    case "PAYER_ACCESS_REQUIRED":
    case "PAYER_ROLE_REQUIRED":
    case "PAYMENT_NOT_AUTHORIZED":
      return "Verified local payer access is required. No capture was requested.";
    case "PAYMENT_RECONCILIATION_REQUIRED":
      return "The admitted provider outcome is unknown. ScopeLedger did not retry it automatically; reconcile the original operation.";
    case "CHECKOUT_NOT_PREPARED":
    case "CHECKOUT_NOT_READY":
      return "The original server-recorded Checkout attempt is not ready for capture.";
    default:
      return "Authoritative payment verification is unavailable. Nothing was marked paid or ready.";
  }
}

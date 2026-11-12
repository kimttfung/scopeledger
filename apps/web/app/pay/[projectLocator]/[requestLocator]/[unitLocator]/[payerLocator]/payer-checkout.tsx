"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  CustomPaymentProjection,
  SafePaymentResult,
} from "../../../../../api/pay/service";

type PaymentSuccess = Readonly<{
  ok: true;
  state: SafePaymentResult["state"];
  readiness: SafePaymentResult["readiness"];
  providerState?: SafePaymentResult["providerState"];
  recovery?: SafePaymentResult["recovery"];
  checkoutUrl?: string;
}>;
type PaymentFailure = Readonly<{
  ok: false;
  code: string;
  state?: SafePaymentResult["state"];
}>;

export function PayerCheckout({
  initial,
  continuity,
}: Readonly<{
  initial: CustomPaymentProjection;
  continuity: "direct" | "return" | "cancel";
}>) {
  const [payment, setPayment] = useState(initial.payment);
  const [busy, setBusy] = useState<
    "prepare" | "capture" | "reconcile" | "status" | null
  >(null);
  const [error, setError] = useState("");

  async function invoke(
    action: "prepare" | "capture" | "reconcile" | "status",
  ) {
    setBusy(action);
    setError("");
    try {
      const response = await fetch(initial.endpoints[action], {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.json() as PaymentSuccess | PaymentFailure;
      if (!response.ok || !body.ok) {
        throw new Error(body.ok ? "" : body.code);
      }
      setPayment({
        state: body.state,
        readiness: body.readiness,
        ...(body.providerState ? { providerState: body.providerState } : {}),
        ...(body.recovery ? { recovery: body.recovery } : {}),
      });
      if (action === "prepare" && body.checkoutUrl) {
        window.location.assign(body.checkoutUrl);
      }
    } catch (requestError) {
      setError(paymentError(
        requestError instanceof Error ? requestError.message : "",
      ));
    } finally {
      setBusy(null);
    }
  }

  const canPrepare = [
    "not-started",
    "preparing",
    "awaiting-buyer-approval",
  ].includes(payment.state);
  const canCapture = continuity === "return"
    && (
      payment.state === "awaiting-buyer-approval"
      || payment.state === "awaiting-capture"
    );
  const canReconcile = payment.recovery !== "manual-recovery-required"
    && [
      "pending",
      "completed",
      "reconciliation-required",
    ].includes(payment.state);

  return (
    <section className="payment-return-panel">
      <h1>
        {continuity === "return"
          ? "Back from PayPal"
          : continuity === "cancel"
            ? "PayPal approval was not completed here"
            : "Approved custom-unit payment"}
      </h1>
      <p>
        {continuity === "return"
          ? "This browser returned from PayPal. The redirect is not financial proof; capture remains an explicit server-authorized action."
          : continuity === "cancel"
            ? "No payment result is inferred from this browser return. The original server-recorded attempt remains authoritative."
            : "Prepare PayPal Checkout for the exact accepted obligation using the current fixed local payer authority."}
      </p>
      <dl>
        <dt>Project</dt>
        <dd>{initial.projectLabel}</dd>
        <dt>Request</dt>
        <dd>{initial.requestLabel}</dd>
        <dt>Approved unit</dt>
        <dd>{initial.unitTitle}</dd>
        <dt>Exact server amount</dt>
        <dd>{initial.currency} {initial.gross}</dd>
        <dt>Ledger payment state</dt>
        <dd>{payment.state}</dd>
        <dt>Work readiness</dt>
        <dd>{payment.readiness}</dd>
        {payment.providerState && (
          <>
            <dt>Authoritative provider state</dt>
            <dd>{payment.providerState}</dd>
          </>
        )}
      </dl>
      {payment.recovery === "manual-recovery-required" && (
        <div className="payment-return-status">
          <strong>Manual recovery required</strong>
          <p>
            ScopeLedger could not identify exactly one matching capture under
            the original server-known Order. It created no replacement attempt
            and dispatched no duplicate capture.
          </p>
        </div>
      )}
      <div className="payment-return-actions">
        {canPrepare && continuity !== "cancel" && (
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void invoke("prepare")}
          >
            {busy === "prepare"
              ? "Preparing exact Checkout…"
              : payment.state === "awaiting-buyer-approval"
                ? "Continue original PayPal approval"
                : "Prepare PayPal Checkout"}
          </button>
        )}
        {canCapture && (
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void invoke("capture")}
          >
            {busy === "capture"
              ? "Capturing and verifying…"
              : "Capture and verify the original Order"}
          </button>
        )}
        {canReconcile && (
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void invoke("reconcile")}
          >
            {busy === "reconcile"
              ? "Refreshing authoritative status…"
              : "Reconcile the original capture"}
          </button>
        )}
        <button
          className="button"
          type="button"
          disabled={busy !== null}
          onClick={() => void invoke("status")}
        >
          {busy === "status" ? "Refreshing status…" : "Refresh ledger status"}
        </button>
        {continuity === "cancel" && (
          <Link className="button" href={initial.endpoints.return.replace(
            /\/return$/u,
            "",
          )}>
            Return to the original payer page
          </Link>
        )}
        <Link className="button" href="/">
          Return to ScopeLedger
        </Link>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <p>
        No workspace, project, unit, version, digest, obligation, attempt,
        merchant, amount, currency, Order, capture, or provider status is
        accepted from browser input.
      </p>
    </section>
  );
}

function paymentError(code: string): string {
  switch (code) {
    case "PAYER_ACCESS_REQUIRED":
    case "PAYER_ROLE_REQUIRED":
    case "PAYMENT_NOT_AUTHORIZED":
      return "Verified local payer authority is required. No financial operation was dispatched.";
    case "PAYMENT_RECONCILIATION_REQUIRED":
      return "The admitted provider outcome is unknown. ScopeLedger did not retry it automatically.";
    case "CHECKOUT_NOT_PREPARED":
    case "CHECKOUT_NOT_READY":
      return "The original server-recorded Checkout is not ready for this action.";
    case "PAYMENT_INPUT_NOT_ACCEPTED":
      return "Browser payment identity and financial input are not accepted.";
    default:
      return "Authoritative payment verification is unavailable. Nothing was marked paid or ready.";
  }
}

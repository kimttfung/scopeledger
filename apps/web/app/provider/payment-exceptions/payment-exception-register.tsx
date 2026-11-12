"use client";

import { useEffect, useState } from "react";
import type {
  PaymentExceptionRefreshSummary,
  ProviderPaymentException,
} from "../../api/provider/payment-exceptions/service";
import { PaymentExceptionRegisterView } from "./payment-exception-view";
import styles from "./payment-exceptions.module.css";

type ExceptionResponse =
  | Readonly<{
    ok: true;
    exceptions: readonly ProviderPaymentException[];
    summary?: PaymentExceptionRefreshSummary;
  }>
  | Readonly<{ ok: false; code: string; message: string }>;
type SuccessfulExceptionResponse = Extract<ExceptionResponse, { ok: true }>;

async function responseBody(
  response: Response,
): Promise<SuccessfulExceptionResponse> {
  const body = await response.json() as ExceptionResponse;
  if (!response.ok || !body.ok) {
    throw new Error(
      body.ok
        ? "Payment exception records could not be loaded."
        : body.message,
    );
  }
  return body as SuccessfulExceptionResponse;
}

async function loadExceptions(): Promise<readonly ProviderPaymentException[]> {
  const response = await fetch("/api/provider/payment-exceptions", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return (await responseBody(response)).exceptions;
}

export function PaymentExceptionRegister({
  initialExceptions,
}: {
  initialExceptions?: readonly ProviderPaymentException[];
}) {
  const [exceptions, setExceptions] = useState<
    readonly ProviderPaymentException[] | null
  >(initialExceptions ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialExceptions) return;
    let active = true;
    void loadExceptions().then((loaded) => {
      if (active) setExceptions(loaded);
    }).catch((cause: unknown) => {
      if (active) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Payment exception records are unavailable.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [initialExceptions]);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/provider/payment-exceptions", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "refresh" }),
      });
      const body = await responseBody(response);
      setExceptions(body.exceptions);
      const recorded = body.summary?.outcomes.find(
        ({ outcome }) => outcome === "payment-exception-recorded",
      )?.count ?? 0;
      const unresolved = body.summary?.outcomes
        .filter(({ outcome }) => [
          "provider-failure",
          "authoritative-resource-invalid",
          "domain-failure",
          "processor-failure",
        ].includes(outcome))
        .reduce((total, { count }) => total + count, 0) ?? 0;
      setMessage(
        `Authoritative refresh completed. ${recorded} exception observation${
          recorded === 1 ? "" : "s"
        } reduced; ${unresolved} trigger result${
          unresolved === 1 ? "" : "s"
        } still require reconciliation. No payment action was initiated.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Authoritative PayPal refresh is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaymentExceptionRegisterView
      exceptions={exceptions}
      busy={busy}
      message={message}
      error={error}
      onRefresh={() => void refresh()}
      styles={styles}
    />
  );
}

export default PaymentExceptionRegister;

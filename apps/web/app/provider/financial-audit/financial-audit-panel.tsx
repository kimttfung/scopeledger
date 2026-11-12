"use client";

import { useEffect, useState } from "react";
import type {
  ProviderFinancialAuditRun,
  ProviderFinancialAuditStatus,
} from "../../api/provider/financial-audit/service";
import { FinancialAuditView } from "./financial-audit-view";
import styles from "./financial-audit.module.css";

type AuditResponse =
  | Readonly<{
    ok: true;
    status: ProviderFinancialAuditStatus;
    run?: ProviderFinancialAuditRun;
  }>
  | Readonly<{ ok: false; code: string; message: string }>;

async function responseBody(response: Response): Promise<
  Extract<AuditResponse, { ok: true }>
> {
  const body = await response.json() as AuditResponse;
  if (!response.ok || !body.ok) {
    throw new Error(
      body.ok ? "Financial audit health is unavailable." : body.message,
    );
  }
  return body;
}

async function loadStatus(): Promise<ProviderFinancialAuditStatus> {
  const response = await fetch("/api/provider/financial-audit", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return (await responseBody(response)).status;
}

export default function FinancialAuditPanel() {
  const [status, setStatus] = useState<ProviderFinancialAuditStatus | null>(
    null,
  );
  const [run, setRun] = useState<ProviderFinancialAuditRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadStatus().then((loaded) => {
      if (active) setStatus(loaded);
    }).catch((cause: unknown) => {
      if (active) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Financial audit health is unavailable.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const audit = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/provider/financial-audit", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "audit", limit: 50 }),
      });
      const body = await responseBody(response);
      setStatus(body.status);
      setRun(body.run ?? null);
      const unresolved = (body.run?.audit.unresolved ?? 0)
        + (body.run?.webhooks.unresolved ?? 0);
      setMessage(
        unresolved === 0
          ? "Authoritative audit completed without an unresolved operational result. No payment action was initiated."
          : `Authoritative audit completed with ${unresolved} unresolved operational result${
              unresolved === 1 ? "" : "s"
            }. Existing facts and holds were not overridden.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Authoritative financial audit is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <FinancialAuditView
      status={status}
      run={run}
      busy={busy}
      message={message}
      error={error}
      onAudit={() => void audit()}
      styles={styles}
    />
  );
}

"use client";

import { useEffect, useState } from "react";

type Role = "client-approver" | "payer";
type RequestState = {
  challengeId: string;
  expiresAt: string;
  inboxUrl: string;
  previewUrl: string;
  role: Role;
};

export default function AccessDemo() {
  const [role, setRole] = useState<Role>("client-approver");
  const [request, setRequest] = useState<RequestState | null>(null);
  const [code, setCode] = useState("");
  const [verifiedRole, setVerifiedRole] = useState<Role | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/access/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { verified?: boolean; role?: Role }) => {
        if (body.verified && body.role) setVerifiedRole(body.role);
      });
  }, []);

  async function sendCode() {
    setBusy(true);
    setStatus("");
    setVerifiedRole(null);
    try {
      const response = await fetch("/api/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!response.ok) throw new Error("request");
      const body = await response.json() as Omit<RequestState, "role">;
      setRequest({ ...body, role });
      setCode("");
      setStatus("Verification code sent to the local Mailpit inbox.");
    } catch {
      setStatus("The local code could not be sent. Check that Mailpit is running.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (!request) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: request.challengeId,
          code,
        }),
      });
      if (!response.ok) throw new Error("verify");
      const body = await response.json() as { role: Role };
      setVerifiedRole(body.role);
      setStatus("Channel control verified for this local demo session.");
    } catch {
      setStatus("The code is incorrect, expired, superseded, or unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function clearSession() {
    await fetch("/api/access/session", { method: "DELETE" });
    setVerifiedRole(null);
    setRequest(null);
    setCode("");
    setStatus("Local verification session cleared.");
  }

  return (
    <div className="access-demo-form">
      <fieldset className="attestations">
        <legend>Choose the local participant role</legend>
        <label>
          <input
            type="radio"
            name="access-role"
            value="client-approver"
            checked={role === "client-approver"}
            onChange={() => setRole("client-approver")}
          />
          Client approver channel
        </label>
        <label>
          <input
            type="radio"
            name="access-role"
            value="payer"
            checked={role === "payer"}
            onChange={() => setRole("payer")}
          />
          Payer channel
        </label>
      </fieldset>

      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => void sendCode()}
      >
        Send local verification code
      </button>

      {request ? (
        <div className="access-code-entry">
          <label htmlFor="access-code">Six-digit code</label>
          <input
            id="access-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
            }}
          />
          <p className="field-help">
            Expires at {new Date(request.expiresAt).toLocaleTimeString()}.
            Open the private local inbox to read it.
          </p>
          <div className="access-demo-actions">
            <a
              className="button"
              href={request.previewUrl}
              target="_blank"
              rel="noreferrer"
            >
              Preview rendered email
            </a>
            <a
              className="text-button"
              href={request.inboxUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Mailpit source and headers
            </a>
            <button
              className="button"
              type="button"
              disabled={busy || code.length !== 6}
              onClick={() => void verifyCode()}
            >
              Verify code
            </button>
          </div>
        </div>
      ) : null}

      {verifiedRole ? (
        <div className="payment-return-status" role="status">
          <strong>Local channel verified: {verifiedRole}</strong>
          <p>
            This proves control of the local test inbox only. It does not prove
            legal authority, approve terms, nominate a payer, or authorize money.
          </p>
          <button
            className="text-button"
            type="button"
            onClick={() => void clearSession()}
          >
            Clear local verification session
          </button>
        </div>
      ) : null}

      {status ? <p className="access-demo-status" role="status">{status}</p> : null}
    </div>
  );
}

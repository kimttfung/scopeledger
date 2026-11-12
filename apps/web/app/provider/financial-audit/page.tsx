import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import FinancialAuditPanel from "./financial-audit-panel";
import styles from "./financial-audit.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Financial audit health | ScopeLedger",
  description:
    "Protected PayPal financial freshness and webhook-processing health.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

function AccessState({
  title,
  status,
  children,
}: {
  title: string;
  status: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <a className="skip-link" href="#financial-audit-status">
        Skip to financial audit status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected finance health</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="financial-audit-status">
        <section
          className="payment-return-panel"
          aria-labelledby="financial-audit-status-title"
        >
          <h1 id="financial-audit-status-title">{title}</h1>
          <div className="payment-return-status" role="status">
            <strong>{status}</strong>
            {children}
          </div>
          <div className="payment-return-actions">
            <Link className="button" href="/provider">
              Return to provider access
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}

export default async function ProviderFinancialAuditPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <AccessState
        title="Financial audit health is not configured"
        status="Authentication unavailable in this profile"
      >
        <p>
          Add the approved Auth0 tenant configuration before protected
          financial health can be viewed.
        </p>
      </AccessState>
    );
  }
  let session;
  try {
    session = await auth0.getSession();
  } catch {
    return (
      <AccessState
        title="Financial audit health is temporarily unavailable"
        status="Provider authentication could not be read"
      >
        <p>Try again after the authentication service is available.</p>
      </AccessState>
    );
  }
  if (!session) {
    redirect("/auth/login?returnTo=/provider/financial-audit");
  }
  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <AccessState
        title="Additional verification required"
        status="Verified email and MFA assurance are required"
      >
        <p>
          Authentication alone does not grant access. Every health read and
          audit trigger also checks current project inspection authority.
        </p>
      </AccessState>
    );
  }

  return (
    <>
      <a className="skip-link" href="#financial-audit-main">
        Skip to financial audit health
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Financial audit health</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          This surface reports bounded operational health. It cannot dispatch
          a payment, initiate a refund, or replace a financial fact.
        </p>
        <Link href="/provider/payment-exceptions">Payment exceptions</Link>
      </div>
      <main className={styles.main} id="financial-audit-main">
        <section className={styles.intro} aria-labelledby="audit-title">
          <div>
            <h1 id="audit-title">Authoritative payment health</h1>
            <p>
              Scheduled audits re-read known PayPal captures and Orders, then
              reduce only exact authenticated observations. Verified webhook
              receipts remain triggers—not financial proof.
            </p>
          </div>
          <aside className={styles.boundary}>
            <strong>Read and reconcile only</strong>
            Stale facts continue to withhold readiness until the existing
            reducer can establish a permitted current state. History and
            attempts remain intact.
          </aside>
        </section>
        <FinancialAuditPanel />
      </main>
    </>
  );
}

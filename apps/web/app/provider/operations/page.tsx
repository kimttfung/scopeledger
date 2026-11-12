import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import styles from "./operations.module.css";
import WorkStartPanel from "./work-start-panel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provider operations | ScopeLedger",
  description: "Protected provider recording of actual work start.",
  robots: { index: false, follow: false },
};

function ProviderOperationsShell({
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
      <a className="skip-link" href="#provider-operations-status">
        Skip to provider operations status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected operations</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="provider-operations-status">
        <section className="payment-return-panel" aria-labelledby="operations-status-title">
          <h1 id="operations-status-title">{title}</h1>
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

export default async function ProviderOperationsPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <ProviderOperationsShell
        title="Provider operations are not configured"
        status="Authentication unavailable in this profile"
      >
        <p>
          Add the approved Auth0 tenant configuration before provider operations
          can be enabled.
        </p>
      </ProviderOperationsShell>
    );
  }

  let session;
  try {
    session = await auth0.getSession();
  } catch {
    return (
      <ProviderOperationsShell
        title="Provider operations are temporarily unavailable"
        status="Provider authentication could not be read"
      >
        <p>Try again after the authentication service is available.</p>
      </ProviderOperationsShell>
    );
  }
  if (!session) {
    redirect("/auth/login?returnTo=/provider/operations");
  }

  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <ProviderOperationsShell
        title="Additional verification required"
        status="Verified email and MFA assurance are required"
      >
        <p>
          This session does not contain the assurance required for provider
          operations. Authentication alone does not grant product authority.
        </p>
        <p><a href="/auth/logout">Sign out of this provider session</a></p>
      </ProviderOperationsShell>
    );
  }

  return (
    <>
      <a className="skip-link" href="#operations-main">
        Skip to provider operations
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Operations ledger</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          Identity assurance opens this surface. The fixed synthetic provider
          actor still requires a current server-side grant for every operation.
        </p>
        <a href="/provider/analysis">Protected PDF analysis</a>
      </div>
      <main className={styles.main} id="operations-main">
        <section className={styles.heading} aria-labelledby="operations-title">
          <h1 id="operations-title">Actual work start</h1>
          <p>
            Readiness and work start are separate facts. This surface records
            that work actually began only after the server independently
            confirms the accepted unit remains ready and unheld.
          </p>
        </section>
        <WorkStartPanel />
      </main>
    </>
  );
}

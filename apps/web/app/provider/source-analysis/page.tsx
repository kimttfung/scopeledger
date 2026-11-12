import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import SourceAnalysisWorkspace from "./source-analysis-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admitted source analysis | ScopeLedger",
  description: "Protected analysis of immutable admitted provider sources.",
  robots: { index: false, follow: false },
};

function StatusShell({
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
      <a className="skip-link" href="#provider-source-analysis-status">
        Skip to source analysis status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected access</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="provider-source-analysis-status">
        <section
          aria-labelledby="provider-source-analysis-title"
          className="payment-return-panel"
        >
          <h1 id="provider-source-analysis-title">{title}</h1>
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

export default async function ProviderSourceAnalysisPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <StatusShell
        status="Authentication unavailable in this profile"
        title="Admitted source analysis is not configured"
      >
        <p>
          Add the approved Auth0 tenant configuration before protected source
          analysis can be enabled.
        </p>
      </StatusShell>
    );
  }

  const session = await auth0.getSession();
  if (!session) {
    redirect("/auth/login?returnTo=/provider/source-analysis");
  }
  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <StatusShell
        status="Verified email and MFA assurance are required"
        title="Additional verification required"
      >
        <p>
          Sign out and complete the configured Auth0 verification flow before
          analyzing admitted provider sources.
        </p>
        <p><a href="/auth/logout">Sign out of this provider session</a></p>
      </StatusShell>
    );
  }

  return (
    <>
      <a className="skip-link" href="#source-analysis-main">
        Skip to admitted source analysis
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Immutable source analysis</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          Analyze exact bytes already admitted to private storage. Stored
          sharing and model permissions remain authoritative.
        </p>
        <Link href="/provider/analysis">Use the separate PDF upload demo</Link>
      </div>
      <SourceAnalysisWorkspace />
    </>
  );
}

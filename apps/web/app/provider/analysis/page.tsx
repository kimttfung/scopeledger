import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import AnalysisUpload from "./analysis-upload";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provider PDF analysis | ScopeLedger",
  description: "Protected, ephemeral provider PDF analysis.",
  robots: { index: false, follow: false },
};

function ProviderAnalysisShell({
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
      <a className="skip-link" href="#provider-analysis-status">
        Skip to provider analysis status
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
      <main className="payment-return-shell" id="provider-analysis-status">
        <section
          aria-labelledby="provider-analysis-title"
          className="payment-return-panel"
        >
          <h1 id="provider-analysis-title">{title}</h1>
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

export default async function ProviderAnalysisPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <ProviderAnalysisShell
        status="Authentication unavailable in this profile"
        title="Provider analysis is not configured"
      >
        <p>
          Add the approved Auth0 tenant configuration before protected PDF
          analysis can be enabled.
        </p>
      </ProviderAnalysisShell>
    );
  }

  const session = await auth0.getSession();
  if (!session) {
    redirect("/auth/login?returnTo=/provider/analysis");
  }

  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <ProviderAnalysisShell
        status="Verified email and MFA assurance are required"
        title="Additional verification required"
      >
        <p>
          This session does not contain the assurance required for provider
          analysis. Sign out and complete the configured Auth0 verification
          flow.
        </p>
        <ul>
          <li>
            Verified email claim:{" "}
            {assurance.emailVerified ? "present" : "missing"}
          </li>
          <li>
            MFA assurance claim: {assurance.mfaVerified ? "present" : "missing"}
          </li>
          <li>
            ScopeLedger custom MFA claim: {assurance.customMfaClaim}
          </li>
        </ul>
        <p><a href="/auth/logout">Sign out of this provider session</a></p>
      </ProviderAnalysisShell>
    );
  }

  return (
    <>
      <a className="skip-link" href="#analysis-main">
        Skip to provider PDF analysis
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Ephemeral analysis</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          One PDF, isolated extraction, optional Gemini candidates. Nothing is
          persisted or publishable.
        </p>
        <a href="/provider">Provider access status</a>
      </div>
      <AnalysisUpload />
    </>
  );
}

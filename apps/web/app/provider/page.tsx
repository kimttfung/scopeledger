import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../lib/auth0";
import { providerAssurance } from "../../lib/provider-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provider access | ScopeLedger",
  description: "Protected ScopeLedger provider access.",
  robots: { index: false, follow: false },
};

function ProviderShell({
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
      <a className="skip-link" href="#provider-main">
        Skip to provider access
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
      <main className="payment-return-shell" id="provider-main">
        <section
          className="payment-return-panel"
          aria-labelledby="provider-title"
        >
          <h1 id="provider-title">{title}</h1>
          <div className="payment-return-status" role="status">
            <strong>{status}</strong>
            {children}
          </div>
          <div className="payment-return-actions">
            <Link className="button" href="/">
              Return to client review
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}

export default async function ProviderPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <ProviderShell
        title="Provider access is not configured"
        status="Authentication unavailable in this profile"
      >
        <p>
          Add the approved Auth0 tenant configuration before provider or staff
          access can be enabled. The synthetic client-review prototype remains
          available without granting a provider session.
        </p>
      </ProviderShell>
    );
  }

  const session = await auth0.getSession();
  if (!session) redirect("/auth/login?returnTo=/provider");

  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <ProviderShell
        title="Additional verification required"
        status="Verified email and MFA assurance are required"
      >
        <p>
          This session does not contain the assurance required for provider
          publishing or payment administration. Sign out and complete the
          configured Auth0 verification flow.
        </p>
        <ul>
          <li>
            Verified email claim: {assurance.emailVerified ? "present" : "missing"}
          </li>
          <li>
            MFA assurance claim: {assurance.mfaVerified ? "present" : "missing"}
          </li>
        </ul>
        <p>
          <a href="/auth/logout">Sign out of this provider session</a>
        </p>
      </ProviderShell>
    );
  }

  return (
    <ProviderShell
      title="Provider session verified"
      status="Authenticated provider access"
    >
      <p>
        Signed in as {assurance.email ?? assurance.subject}. MFA and verified
        email assurance are present. Product permissions still require current
        server-side grants; authentication alone grants no commercial authority.
      </p>
      <p>
        <a href="/auth/logout">Sign out</a>
      </p>
    </ProviderShell>
  );
}

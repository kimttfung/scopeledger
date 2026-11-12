import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import styles from "./authoring.module.css";
import AuthoringWorkspace from "./authoring-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provider authoring | ScopeLedger",
  description:
    "Protected provider source intake and immutable draft authoring.",
  robots: { index: false, follow: false },
};

function ProviderAuthoringShell({
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
      <a className="skip-link" href="#provider-authoring-status">
        Skip to provider authoring status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected authoring</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="provider-authoring-status">
        <section className="payment-return-panel" aria-labelledby="authoring-status-title">
          <h1 id="authoring-status-title">{title}</h1>
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

export default async function ProviderAuthoringPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <ProviderAuthoringShell
        title="Provider authoring is not configured"
        status="Authentication unavailable in this profile"
      >
        <p>
          Add the approved Auth0 tenant configuration before protected provider
          authoring can be enabled.
        </p>
      </ProviderAuthoringShell>
    );
  }

  let session;
  try {
    session = await auth0.getSession();
  } catch {
    return (
      <ProviderAuthoringShell
        title="Provider authoring is temporarily unavailable"
        status="Provider authentication could not be read"
      >
        <p>Try again after the authentication service is available.</p>
      </ProviderAuthoringShell>
    );
  }
  if (!session) {
    redirect("/auth/login?returnTo=/provider/authoring");
  }

  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <ProviderAuthoringShell
        title="Additional verification required"
        status="Verified email and MFA assurance are required"
      >
        <p>
          This session does not contain the assurance required for provider
          authoring. Authentication alone does not grant product authority.
        </p>
        <p><a href="/auth/logout">Sign out of this provider session</a></p>
      </ProviderAuthoringShell>
    );
  }

  return (
    <>
      <div
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: `<!--
THESIS: Authoring is a split ledger where immutable revision chronology and exact commercial preparation remain distinct; it refuses a dashboard of interchangeable cards.
OWN-WORLD: Cool-white studio surfaces, restrained cobalt actions, fine rules, and a flat register/worktable composition.
STORY: The provider selects or creates a project and request, records bounded draft content, prepares an exact preview, then explicitly publishes only eligible terms.
FIRST VIEWPORT: A project/request register occupies the left rail; the selected request opens a broad draft and commercial workbench with immutable history on the right.
FORM: Candidate 3 of six grounded structures, a split ledger worktable with light-table history staging; seed 947a78b3.
-->`,
        }}
      />
      <a className="skip-link" href="#authoring-main">
        Skip to provider authoring
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Authoring ledger</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          Verified identity opens this surface. Every API action independently
          requires the fixed synthetic provider&apos;s current server-side grant.
        </p>
        <Link href="/provider">Provider access</Link>
      </div>
      <main className={styles.main} id="authoring-main">
        <section className={styles.intro} aria-labelledby="authoring-title">
          <div className={styles.introCopy}>
            <h1 id="authoring-title">Provider authoring ledger</h1>
            <p>
              Create a project and request, admit permitted source material, then
              explicitly activate its local client approver before building
              sequential draft revisions. A latest review-ready revision can then
              receive provider-reviewed commercial terms, a separate preview, and
              an explicit publication confirmation.
            </p>
          </div>
          <div className={styles.availability}>
            <strong>Prepare, preview, then publish</strong>
            Confirm an admitted source as project baseline first. Only the latest
            review-ready revision with complete coverage can publish payable or
            waived terms. Client authority uses a separate preview and confirmation;
            publication creates no decision, payment, or readiness.
          </div>
        </section>
        <AuthoringWorkspace />
      </main>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import ReconciliationWorkspace from "./reconciliation-workspace";
import styles from "./reconciliation.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Provider reconciliation | ScopeLedger",
  description:
    "Protected provider questions and correction assessment inbox.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const directionContract = `<!--
THESIS: Reconciliation is a ruled correspondence register where communication and material applicability remain visibly separate; it refuses a metrics dashboard or a card grid.
OWN-WORLD: Existing Studio Standards—cool white, ink, cobalt actions, fine rules, flat registers, native controls, and no decorative elevation.
STORY: The verified provider reads only grant-authorized client questions and correction concerns, records an attributed response, and explicitly chooses whether a correction changes the current terms.
FIRST VIEWPORT: A bounded workflow explanation leads directly into two full-width registers: communication first, correction applicability second, with inline actions attached to exact versions.
FORM: Established-world task register for a precisely bounded provider workflow; no concept seed was required.
-->`;

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
      <a className="skip-link" href="#provider-reconciliation-status">
        Skip to provider reconciliation status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected reconciliation</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main
        className="payment-return-shell"
        id="provider-reconciliation-status"
      >
        <section
          className="payment-return-panel"
          aria-labelledby="reconciliation-status-title"
        >
          <h1 id="reconciliation-status-title">{title}</h1>
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

export default async function ProviderReconciliationPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <AccessState
        title="Provider reconciliation is not configured"
        status="Authentication unavailable in this profile"
      >
        <p>
          Add the approved Auth0 tenant configuration before protected
          reconciliation can be enabled.
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
        title="Provider reconciliation is temporarily unavailable"
        status="Provider authentication could not be read"
      >
        <p>Try again after the authentication service is available.</p>
      </AccessState>
    );
  }
  if (!session) {
    redirect("/auth/login?returnTo=/provider/reconciliation");
  }
  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <AccessState
        title="Additional verification required"
        status="Verified email and MFA assurance are required"
      >
        <p>
          Authentication alone does not grant access to provider questions or
          correction concerns. A current server-side product grant is also
          required by every API operation.
        </p>
      </AccessState>
    );
  }

  return (
    <>
      <div
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: directionContract }}
      />
      <a className="skip-link" href="#reconciliation-main">
        Skip to provider reconciliation
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Reconciliation register</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          Verified identity opens this surface. Every list and response
          independently rechecks the current project grant.
        </p>
        <Link href="/provider">Provider access</Link>
      </div>
      <main className={styles.main} id="reconciliation-main">
        <section className={styles.intro} aria-labelledby="reconciliation-title">
          <div>
            <h1 id="reconciliation-title">Questions and correction concerns</h1>
            <p>
              Questions remain communication-only. Corrections require an
              explicit applicability assessment and provider response before
              the client can acknowledge unchanged terms or review a reissue.
            </p>
          </div>
          <aside className={styles.boundary}>
            <strong>No silent clearance</strong>
            A provider response never clears a material correction hold.
            Material change creates only an in-progress draft; preparation,
            publication, and fresh client consent remain separate.
          </aside>
        </section>
        <ReconciliationWorkspace />
      </main>
    </>
  );
}

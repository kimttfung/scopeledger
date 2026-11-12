import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";
import PaymentExceptionRegister from "./payment-exception-register";
import styles from "./payment-exceptions.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Payment exceptions | ScopeLedger",
  description:
    "Protected read-only PayPal refund and capture-reversal register.",
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
      <a className="skip-link" href="#payment-exception-status">
        Skip to payment exception status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected finance register</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="payment-exception-status">
        <section
          className="payment-return-panel"
          aria-labelledby="payment-exception-status-title"
        >
          <h1 id="payment-exception-status-title">{title}</h1>
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

export default async function ProviderPaymentExceptionsPage() {
  if (!auth0Environment.configured || !auth0) {
    return (
      <AccessState
        title="Payment exceptions are not configured"
        status="Authentication unavailable in this profile"
      >
        <p>
          Add the approved Auth0 tenant configuration before protected
          financial exception records can be viewed.
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
        title="Payment exceptions are temporarily unavailable"
        status="Provider authentication could not be read"
      >
        <p>Try again after the authentication service is available.</p>
      </AccessState>
    );
  }
  if (!session) {
    redirect("/auth/login?returnTo=/provider/payment-exceptions");
  }
  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return (
      <AccessState
        title="Additional verification required"
        status="Verified email and MFA assurance are required"
      >
        <p>
          Authentication alone does not grant access to financial exception
          records. Every API read and refresh also checks current project
          inspection authority.
        </p>
      </AccessState>
    );
  }

  return (
    <>
      <a className="skip-link" href="#payment-exceptions-main">
        Skip to payment exceptions
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Payment exception register</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          This surface reports authoritative observations and readiness holds.
          It cannot move money or declare a provider outcome.
        </p>
        <Link href="/provider">Provider access</Link>
      </div>
      <main className={styles.main} id="payment-exceptions-main">
        <section className={styles.intro} aria-labelledby="exceptions-title">
          <div>
            <h1 id="exceptions-title">Refund and reversal observations</h1>
            <p>
              PayPal webhooks trigger a new exact resource read. Verified
              partial refunds, full refunds, reversals, mismatches, and unknown
              states remain separate from the original capture and withhold
              readiness for affected additional work.
            </p>
          </div>
          <aside className={styles.boundary}>
            <strong>Observation only</strong>
            No refund initiation, replacement collection, inferred debt, or
            manual success and failure override is available here.
          </aside>
        </section>
        <PaymentExceptionRegister />
      </main>
    </>
  );
}

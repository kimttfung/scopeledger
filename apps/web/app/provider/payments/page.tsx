import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { verifiedProvider } from "../../api/analysis/provider-api";
import { listProviderPaymentActivations } from "../../api/provider/payments/runtime";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Payer authority | ScopeLedger",
  description:
    "Protected provider activation for exact approved payment obligations.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ProviderPaymentsPage() {
  const access = await verifiedProvider();
  if (!access.ok) {
    if (access.code === "AUTHENTICATION_REQUIRED") {
      redirect("/auth/login?returnTo=/provider/payments");
    }
    return (
      <ProviderPaymentShell title="Payer authority unavailable">
        <p>{access.message}</p>
      </ProviderPaymentShell>
    );
  }
  let candidates;
  try {
    candidates = await listProviderPaymentActivations();
  } catch {
    return (
      <ProviderPaymentShell title="Payer authority unavailable">
        <p>The current approved payment obligations could not be loaded.</p>
      </ProviderPaymentShell>
    );
  }
  return (
    <ProviderPaymentShell title="Payer authority">
      <p>
        Preview and explicitly activate the fixed verified local payer for one
        exact approved obligation. Approval alone never grants payment authority.
      </p>
      <div className="payment-return-status">
        {candidates.length === 0
          ? <p>No current approved payable obligations are available.</p>
          : (
            <ul>
              {candidates.map((candidate) => (
                <li key={candidate.href}>
                  <Link href={candidate.href} prefetch={false}>
                    {candidate.projectLabel} · {candidate.unitTitle}
                  </Link>
                  {" — "}
                  {candidate.currency} {candidate.gross}
                  {" · "}
                  {candidate.status === "active"
                    ? "Payer active"
                    : "Activation ready"}
                </li>
              ))}
            </ul>
          )}
      </div>
    </ProviderPaymentShell>
  );
}

function ProviderPaymentShell({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) {
  return (
    <>
      <a className="skip-link" href="#provider-payment-main">
        Skip to payer authority
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Protected payment authority</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="provider-payment-main">
        <section className="payment-return-panel">
          <h1>{title}</h1>
          {children}
          <div className="payment-return-actions">
            <Link className="button" href="/provider">
              Return to provider workspace
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}

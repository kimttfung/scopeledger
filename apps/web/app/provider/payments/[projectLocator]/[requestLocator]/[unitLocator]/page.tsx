import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { verifiedProvider } from "../../../../../api/analysis/provider-api";
import type { ReviewLocators } from "../../../../../api/review/service";
import { ProviderPaymentActivationPanel } from "./provider-payment-activation-panel";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Activate payer authority | ScopeLedger",
  description:
    "Preview and activate the fixed local payer for an exact approved obligation.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ProviderPaymentActivationPage({
  params,
}: Readonly<{ params: Promise<ReviewLocators> }>) {
  const access = await verifiedProvider();
  if (!access.ok) {
    if (access.code === "AUTHENTICATION_REQUIRED") {
      redirect("/auth/login?returnTo=/provider/payments");
    }
    return <PaymentActivationAccess message={access.message} />;
  }
  const locators = await params;
  const endpoint = [
    "/api/provider/payments",
    locators.projectLocator,
    locators.requestLocator,
    locators.unitLocator,
  ].join("/");
  return (
    <>
      <a className="skip-link" href="#payer-activation-main">
        Skip to payer activation
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
      <main className="payment-return-shell" id="payer-activation-main">
        <ProviderPaymentActivationPanel endpoint={endpoint} />
      </main>
    </>
  );
}

function PaymentActivationAccess({
  message,
}: Readonly<{ message: string }>) {
  return (
    <main className="payment-return-shell">
      <section className="payment-return-panel">
        <h1>Payer activation unavailable</h1>
        <p>{message}</p>
        <Link className="button" href="/provider/payments">
          Return to payer authority
        </Link>
      </section>
    </main>
  );
}

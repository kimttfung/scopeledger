import type { Metadata } from "next";
import Link from "next/link";
import type { PaymentLocators } from "../../../../../api/pay/database";
import { customPaymentDependencies } from "../../../../../api/pay/runtime";
import { loadCustomPayment } from "../../../../../api/pay/service";
import { PayerCheckout } from "./payer-checkout";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Custom-unit payment | ScopeLedger",
  description:
    "Protected payer Checkout for an exact approved custom-unit obligation.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function CustomPaymentPage({
  params,
}: Readonly<{ params: Promise<PaymentLocators> }>) {
  return <PaymentPage params={await params} continuity="direct" />;
}

export async function PaymentPage({
  params,
  continuity,
}: Readonly<{
  params: PaymentLocators;
  continuity: "direct" | "return" | "cancel";
}>) {
  let dependencies;
  try {
    dependencies = customPaymentDependencies();
  } catch {
    dependencies = null;
  }
  if (!dependencies) {
    return <PaymentAccess code="PAYMENT_ACCESS_UNAVAILABLE" />;
  }
  const result = await loadCustomPayment(params, dependencies);
  return (
    <>
      <a className="skip-link" href="#custom-payment-main">
        Skip to payment
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Protected payer Checkout</span>
          <span className="prototype-label">PayPal Sandbox</span>
          <span className="role-label">Payer</span>
        </div>
      </header>
      <div className="prototype-notice">
        Payment and work start remain separate. Only authoritative server-side
        capture evidence can satisfy the accepted payment condition.
      </div>
      <main className="payment-return-shell" id="custom-payment-main">
        {result.ok
          ? (
            <PayerCheckout
              initial={result.payment}
              continuity={continuity}
            />
          )
          : <PaymentAccess code={result.code} />}
      </main>
    </>
  );
}

function PaymentAccess({ code }: Readonly<{ code: string }>) {
  const copy = code === "PAYER_ACCESS_REQUIRED"
    ? "Verify the fixed local payer session before opening this opaque payment URL."
    : code === "PAYER_ROLE_REQUIRED" || code === "PAYMENT_NOT_AUTHORIZED"
      ? "This verified session does not hold current payer authority for the exact approved obligation."
      : code === "PAYMENT_NOT_AVAILABLE"
        ? "This opaque payer URL is not available."
        : code === "PAYMENT_STATE_CHANGED"
          ? "The accepted obligation or payer authority changed. Request a current opaque payer URL."
          : "Protected payer Checkout is temporarily unavailable.";
  return (
    <section className="payment-return-panel">
      <h1>Payment access unavailable</h1>
      <p>{copy}</p>
      <div className="payment-return-actions">
        <Link className="button" href="/access-demo">
          Verify local payer access
        </Link>
        <Link className="button" href="/">
          Return to ScopeLedger
        </Link>
      </div>
    </section>
  );
}

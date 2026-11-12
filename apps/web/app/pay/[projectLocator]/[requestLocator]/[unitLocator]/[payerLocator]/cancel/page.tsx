import { redirect } from "next/navigation";
import type { PaymentLocators } from "../../../../../../api/pay/database";
import {
  payerPagePath,
} from "../../../../../../api/pay/service";
import { PaymentPage } from "../page";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export default async function CustomPaymentCancelPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<PaymentLocators>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const locators = await params;
  if (Object.keys(await searchParams).length > 0) {
    redirect(`${payerPagePath(locators)}/cancel`);
  }
  return <PaymentPage params={locators} continuity="cancel" />;
}

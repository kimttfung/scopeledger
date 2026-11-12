import {
  DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  MAX_FINANCIAL_AUDIT_BATCH_LIMIT,
  type PayPalFinancialAuditSummary,
} from "./financial-audit.js";
import type { PayPalWebhookHealthSummary } from "./webhook-processor.js";

export type FinancialAuditCliOptions = Readonly<{
  mode: "run" | "status";
  limit: number;
  auditIntervalMilliseconds: number;
}>;

function optionValue(
  argumentsList: readonly string[],
  index: number,
  name: string,
): Readonly<{ value: string; consumed: number }> | null {
  const argument = argumentsList[index]!;
  if (argument === name) {
    const value = argumentsList[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    return Object.freeze({ value, consumed: 2 });
  }
  if (argument.startsWith(`${name}=`)) {
    return Object.freeze({
      value: argument.slice(name.length + 1),
      consumed: 1,
    });
  }
  return null;
}

export function parseFinancialAuditCliArguments(
  argumentsList: readonly string[],
): FinancialAuditCliOptions {
  let mode: FinancialAuditCliOptions["mode"] = "run";
  let limit: number | null = null;
  for (let index = 0; index < argumentsList.length;) {
    const argument = argumentsList[index]!;
    if (argument === "--status") {
      mode = "status";
      index += 1;
      continue;
    }
    const parsedLimit = optionValue(argumentsList, index, "--limit");
    if (parsedLimit) {
      if (limit !== null) throw new Error("--limit may be supplied once");
      limit = Number(parsedLimit.value);
      index += parsedLimit.consumed;
      continue;
    }
    throw new Error(`Unsupported financial audit option: ${argument}`);
  }
  if (
    limit === null
    || !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_FINANCIAL_AUDIT_BATCH_LIMIT
  ) {
    throw new Error(
      `--limit must be an integer from 1 to ${
        MAX_FINANCIAL_AUDIT_BATCH_LIMIT
      }`,
    );
  }
  return Object.freeze({
    mode,
    limit,
    auditIntervalMilliseconds:
      DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  });
}

export function financialAuditExitCode(input: Readonly<{
  audit: PayPalFinancialAuditSummary;
  webhooks: PayPalWebhookHealthSummary;
}>): 0 | 1 {
  return input.audit.unresolved > 0 || input.webhooks.unresolved > 0 ? 1 : 0;
}

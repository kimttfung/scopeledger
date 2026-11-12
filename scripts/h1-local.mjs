import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  H1_LOCAL_EXIT_CODES,
  formatH1LocalReport,
  h1LocalUsage,
  parseH1LocalArguments,
  runH1LocalCommand,
} from "./h1-local-core.mjs";

export async function main(argumentsList = process.argv.slice(2)) {
  const parsed = parseH1LocalArguments(argumentsList);
  if (parsed.help) {
    console.log(h1LocalUsage());
    return H1_LOCAL_EXIT_CODES.ok;
  }
  if (parsed.error) {
    if (parsed.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        command: null,
        ok: false,
        error: parsed.error,
        usage: h1LocalUsage(),
      }, null, 2));
    } else {
      console.error(parsed.error);
      console.error(h1LocalUsage());
    }
    return H1_LOCAL_EXIT_CODES.usage;
  }
  try {
    const result = await runH1LocalCommand(parsed);
    console.log(
      parsed.json
        ? JSON.stringify(result.report, null, 2)
        : formatH1LocalReport(result.report),
    );
    return result.exitCode;
  } catch {
    const report = {
      schemaVersion: 1,
      command: parsed.command,
      ok: false,
      error: "Unexpected local orchestrator failure.",
      remediation: "Run doctor for safe read-only diagnostics.",
    };
    if (parsed.json) console.log(JSON.stringify(report, null, 2));
    else console.error(`${report.error} ${report.remediation}`);
    return H1_LOCAL_EXIT_CODES.notReady;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}

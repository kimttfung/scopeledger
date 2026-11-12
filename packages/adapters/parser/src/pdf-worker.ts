import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const path = process.argv[2];
if (!path || process.env.SCOPELEDGER_PARSER_CHILD !== "1") {
  process.exitCode = 1;
} else {
  try {
    const bytes = new Uint8Array(await readFile(path));
    const declaredByteLength = bytes.byteLength;
    const loadingTask = getDocument({
      data: bytes,
      disableAutoFetch: true,
      disableStream: true,
      useWorkerFetch: false,
      useWasm: false,
      useSystemFonts: false,
      stopAtErrors: true,
      enableXfa: false,
      verbosity: 0,
    });
    const document = await loadingTask.promise;
    if (document.numPages > 50) {
      console.error("PAGE_LIMIT_EXCEEDED");
      process.exitCode = 2;
    } else {
      const pages: { pageNumber: number; start: number; end: number }[] = [];
      const text: string[] = [];
      let offset = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items
          .flatMap((item) => "str" in item ? [item.str] : [])
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        const value = pageNumber === document.numPages
          ? pageText
          : `${pageText}\n`;
        const start = offset;
        offset += Array.from(value).length;
        pages.push({ pageNumber, start, end: offset });
        text.push(value);
        page.cleanup();
      }
      await loadingTask.destroy();
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        format: "pdf",
        declaredByteLength,
        declaredPageCount: pages.length,
        extractedText: text.join(""),
        pages,
        unavailablePages: [],
        extractorReference: "scopeledger.pdfjs.v1",
      }));
    }
  } catch {
    process.exitCode = 1;
  }
}

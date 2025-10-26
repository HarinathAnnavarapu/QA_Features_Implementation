import path from "node:path";
import fs from "node:fs/promises";
import { Document } from "@langchain/core/documents";

const loaderCache = new Map<string, any>();

async function getLoader(type: string) {
  if (!loaderCache.has(type)) {
    switch (type) {
      case "pdf":
        const { PDFLoader } = await import("@langchain/community/document_loaders/fs/pdf");
        loaderCache.set(type, PDFLoader);
        break;
      case "docx":
        const { DocxLoader } = await import("@langchain/community/document_loaders/fs/docx");
        loaderCache.set(type, DocxLoader);
        break;
      case "csv":
        const { CSVLoader } = await import("@langchain/community/document_loaders/fs/csv");
        loaderCache.set(type, CSVLoader);
        break;
      case "txt":
        const { TextLoader } = await import("langchain/document_loaders/fs/text");
        loaderCache.set(type, TextLoader);
        break;
      case "xlsx":
        // Some distributions do not include a dedicated XLSX loader. Use the PPTX loader as a pragmatic
        // fallback (many unstructured parsers can still extract text), but prefer installing a proper XLSX loader.
        const { PPTXLoader: XLSXFallback } = await import("@langchain/community/document_loaders/fs/pptx");
        loaderCache.set(type, XLSXFallback);
        break;
      case "ppt":
      case "pptx":
        try {
          const { PPTXLoader: PowerPointLoader } = await import("@langchain/community/document_loaders/fs/pptx");
          loaderCache.set(type, PowerPointLoader);
        } catch (importErr) {
          // If the community PPTX loader cannot be imported (missing native deps like 'officeparser'),
          // register a JS-only fallback loader class that extracts slide text via jszip at runtime.
          class PPTXJszipFallback {
            filePath: string;
            constructor(filePath: string) {
              this.filePath = filePath;
            }
            async load() {
              const JSZipModule = await import("jszip");
              const JSZip = JSZipModule.default ?? JSZipModule;
              const buffer = await fs.readFile(this.filePath);
              const zip = await JSZip.loadAsync(buffer);

              const slideKeys = Object.keys(zip.files)
                .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
                .sort((a, b) => {
                  const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
                  const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
                  return na - nb;
                });

              const slides: Array<Document> = [];
              for (const key of slideKeys) {
                const xml = await zip.file(key)!.async("string");
                const matches = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g));
                const text = matches.map((m) => m[1]).join(" ").replace(/\s+/g, " ").trim();
                slides.push({ pageContent: text } as Document);
              }

              return slides;
            }
          }

          loaderCache.set(type, PPTXJszipFallback);
        }
        break;
    }
  }
  return loaderCache.get(type);
}

export async function loadDocumentToString(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === ".pdf") {
      const PDFLoader = await getLoader("pdf");
      const loader = new PDFLoader(filePath, {
        parsedItemSeparator: "\n\n",
        splitPages: true
      });
      const pdfDocs = await loader.load();
      
      return pdfDocs
        .map((d: Document, i: number) => `[Page ${i + 1}]\n${d.pageContent.trim()}`)
        .join("\n\n---\n\n");
    }

    if (ext === ".docx") {
      const DocxLoader = await getLoader("docx");
      const docs = await new DocxLoader(filePath).load();
      
      return docs
        .map((d: Document) => d.pageContent.trim())
        .filter((content: string) => content.length > 0)
        .join("\n\n");
    }

    if (ext === ".csv") {
      const CSVLoader = await getLoader("csv");

      // Try common strategies: preferred 'content' column, then default loader, then manual parse fallback.
      let docs: Array<Document> | undefined;
      try {
        // some CSVs contain a dedicated 'content' column used by the loader
        docs = await new CSVLoader(filePath, "content").load();
      } catch (err1) {
        try {
          // try the loader without a column (if supported)
          docs = await new CSVLoader(filePath).load();
        } catch (err2) {
          // final fallback: manual parsing to ensure we always return text
          const raw = await fs.readFile(filePath, "utf8");
          const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (lines.length === 0) return "";
          const header = lines[0].split(",").map((h) => h.trim());
          const rows = lines.slice(1);

          const parsedDocs = rows.map((row) => {
            const values = row.split(",");
            const pairs = header.map((h, i) => `${h}: ${values[i] !== undefined ? values[i].trim() : ""}`);
            return { pageContent: pairs.join(" | ") } as Document;
          });

          return parsedDocs
            .map((d) => d.pageContent.trim())
            .filter((c) => c.length > 0)
            .join("\n\n");
        }
      }

      // If we got documents from loader(s) above, return them normalized
      return (docs ?? [])
        .map((d: Document) => d.pageContent.trim())
        .filter((content: string) => content.length > 0)
        .join("\n\n");
    }

    if (ext === ".xlsx") {
      const PPTXLoader = await getLoader("xlsx");
      const docs = await new PPTXLoader(filePath).load();
      
      return docs
        .map((d: Document) => d.pageContent.trim())
        .filter((content: string) => content.length > 0)
        .join("\n\n---\n\n");
    }

    if (ext === ".ppt" || ext === ".pptx") {
      const loaderKey = ext.substring(1); // 'ppt' or 'pptx'
      const PowerPointLoader = await getLoader(loaderKey);

      try {
        const docs = await new PowerPointLoader(filePath).load();

        return docs
          .map((d: Document, i: number) => `[Slide ${i + 1}]\n${d.pageContent.trim()}`)
          .filter((content: string) => content.length > 0)
          .join("\n\n---\n\n");
      } catch (pptErr) {
        // If the community loader failed due to missing native deps (e.g. "officeparser"),
        // try a JS-only fallback using jszip to extract slide xml and pull <a:t> text nodes.
        const errMsg = pptErr instanceof Error ? pptErr.message : String(pptErr);
        if (errMsg.includes("officeparser") || errMsg.toLowerCase().includes("cannot find package")) {
          try {
            const JSZipModule = await import("jszip");
            const JSZip = JSZipModule.default ?? JSZipModule;
            const buffer = await fs.readFile(filePath);
            const zip = await JSZip.loadAsync(buffer);

            const slideKeys = Object.keys(zip.files)
              .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
              .sort((a, b) => {
                const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
                const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
                return na - nb;
              });

            const slides: Array<{ pageContent: string }> = [];
            for (const key of slideKeys) {
              const xml = await zip.file(key)!.async("string");
              // Extract text nodes inside <a:t> tags (common in PPTX slide xml)
              const matches = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g));
              const text = matches.map((m) => m[1]).join(" ").replace(/\s+/g, " ").trim();
              slides.push({ pageContent: text });
            }

            if (slides.length === 0) {
              throw new Error("No slide text extracted by jszip fallback.");
            }

            return slides
              .map((d, i) => `[Slide ${i + 1}]\n${d.pageContent.trim()}`)
              .filter((c) => c.length > 0)
              .join("\n\n---\n\n");
          } catch (zipErr) {
            // Fall through to throw the original pptErr with more context
            throw new Error(
              `PowerPoint loader failed for ${filePath}: ${errMsg}. ` +
                `Attempted jszip fallback but it failed: ${zipErr instanceof Error ? zipErr.message : String(zipErr)}. ` +
                `Install 'officeparser' or add 'jszip' to enable the fallback (npm i jszip).`
            );
          }
        }

        // Generic failure for PPT loader: rethrow with guidance
        throw new Error(
          `PowerPoint loader failed for ${filePath}: ${errMsg}. ` +
            `Ensure your @langchain/community version provides a PPT/PPTX loader or install a compatible dependency (e.g. 'officeparser').`
        );
      }
    }

    if (ext === ".txt") {
      const TextLoader = await getLoader("txt");
      const docs = await new TextLoader(filePath).load();
      
      return docs
        .map((d: Document) => d.pageContent.trim())
        .filter((content: string) => content.length > 0)
        .join("\n\n");
    }

    // Plain text fallback for other file types (optimized for large files)
    const stats = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, "utf8");
    
    // For very large files, provide a warning in metadata
    if (stats.size > 1_000_000) { // > 1MB
      console.warn(`Large file loaded: ${filePath} (${(stats.size / 1_000_000).toFixed(2)}MB)`);
    }
    
    return raw.trim();
    
  } catch (error) {
    throw new Error(
      `Failed to load ${ext} file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

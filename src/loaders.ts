import path from "node:path";
import fs from "node:fs/promises";
import { Document } from "@langchain/core/documents";

const loaderCache = new Map<string, any>();

// Extension to loader key mapping used across the app
const EXT_TO_LOADER: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".csv": "csv",
  ".txt": "txt",
  ".xlsx": "xlsx",
  ".ppt": "ppt",
  ".pptx": "pptx"
};

export function extensionToLoaderType(ext: string): string | null {
  const key = ext?.toLowerCase();
  return (EXT_TO_LOADER as Record<string, string | undefined>)[key] ?? null;
}

export function supportedExtensions(): string[] {
  return Object.keys(EXT_TO_LOADER);
}

// Remove non-printable/control characters (except common whitespace like \t, \r, \n)
// and normalize repeated whitespace while preserving paragraph breaks where useful.
function sanitizeText(input: string): string {
  if (!input || typeof input !== "string") return "";
  // Remove the Unicode replacement char and other control chars that often appear
  // when binary data is mis-decoded.
  let s = input.replace(/\uFFFD/g, "");
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // Normalize whitespace but preserve newlines and carriage returns.
  s = s.replace(/[\u00A0]/g, ' '); // non-breaking spaces -> regular space
  s = s.replace(/[^\S\r\n]+/g, ' ');
  // Trim and collapse multiple blank lines to a single blank line
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function sanitizeDocs(docs: Document[] | undefined): Document[] {
  if (!Array.isArray(docs)) return [];
  return docs.map((d) => ({
    ...d,
    pageContent: sanitizeText(d.pageContent ?? "")
  } as Document));
}

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

export async function loadDocumentToString(filePath: string, opts?: { originalName?: string }): Promise<string> {
  const ext = path.extname(opts?.originalName ?? filePath).toLowerCase();

  try {
    if (ext === ".pdf") {
      const PDFLoader = await getLoader("pdf");
      const loader = new PDFLoader(filePath, {
        parsedItemSeparator: "\n\n",
        splitPages: true
      });
      const pdfDocs = await loader.load();
      
      return pdfDocs
        .map((d: Document, i: number) => `[Page ${i + 1}]\n${sanitizeText(d.pageContent)}`)
        .join("\n\n---\n\n");
    }

    if (ext === ".docx") {
      const DocxLoader = await getLoader("docx");
      const docs = await new DocxLoader(filePath).load();
      
      return docs
        .map((d: Document) => sanitizeText(d.pageContent))
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
        .map((d: Document) => sanitizeText(d.pageContent))
        .filter((content: string) => content.length > 0)
        .join("\n\n");
    }

    if (ext === ".xlsx") {
      const PPTXLoader = await getLoader("xlsx");
      const docs = await new PPTXLoader(filePath).load();
      
      return docs
        .map((d: Document) => sanitizeText(d.pageContent))
        .filter((content: string) => content.length > 0)
        .join("\n\n---\n\n");
    }

    if (ext === ".ppt" || ext === ".pptx") {
      const loaderKey = ext.substring(1); // 'ppt' or 'pptx'
      const PowerPointLoader = await getLoader(loaderKey);

      try {
        const docs = await new PowerPointLoader(filePath).load();

        return docs
          .map((d: Document, i: number) => `[Slide ${i + 1}]\n${sanitizeText(d.pageContent)}`)
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
              slides.push({ pageContent: sanitizeText(text) });
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

export async function loadDocument(filePath: string, opts?: { originalName?: string }): Promise<Document[]> {
  const ext = path.extname(opts?.originalName ?? filePath).toLowerCase();
  try {
    if (ext === ".pdf") {
      try {
        // Try pdf-parse first as it's most reliable
        const pdfParse = (await import("pdf-parse")).default;
        const buffer = await fs.readFile(filePath);
        const data = await pdfParse(buffer);

        // Normalize smart quotes and other special characters first
        const normalizedText = (data.text ?? "")
          .replace(/[\u0091\u0092\u2018\u2019]/g, "'")
          .replace(/[\u201C\u201D]/g, '"');

        // Sanitize the whole extracted text
        const cleaned = sanitizeText(normalizedText);

        // Split into pages if we can detect page breaks
        const pages = cleaned.split(/\f|\[Page \d+\]/).filter(p => p.trim());
        if (pages.length > 1) {
          return pages.map((pageContent, i) => ({
            pageContent: sanitizeText(pageContent),
            metadata: { page: i + 1 }
          })) as Document[];
        }

        // No clear page breaks, return as single document
        return [{
          pageContent: cleaned.replace(/\s+/g, ' ').trim(),
          metadata: { pages: data.numpages }
        } as Document];
      } catch (err1) {
        console.warn("pdf-parse failed, trying PDFLoader:", err1);
        try {
          // Fallback to LangChain's PDFLoader
          const PDFLoader = await getLoader("pdf");
          const loader = new PDFLoader(filePath, {
            parsedItemSeparator: "\n\n",
            splitPages: true
          });
          const docs = await loader.load();
          // Sanitize and return
          return sanitizeDocs(docs);
        } catch (err2) {
          console.error("Both PDF parsers failed:", err1, err2);
          throw new Error(`Failed to parse PDF: ${err2}`);
        }
      }
    }
    if (ext === ".docx") {
      const DocxLoader = await getLoader("docx");
      return sanitizeDocs(await new DocxLoader(filePath).load());
    }
    if (ext === ".csv") {
      const CSVLoader = await getLoader("csv");
      try {
        return sanitizeDocs(await new CSVLoader(filePath, "content").load());
      } catch (err1) {
        try {
          return sanitizeDocs(await new CSVLoader(filePath).load());
        } catch (err2) {
          // fallback: manual parse
          const raw = await fs.readFile(filePath, "utf8");
          const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (lines.length === 0) return [];
          const header = lines[0].split(",").map((h) => h.trim());
          const rows = lines.slice(1);
          const parsed = rows.map((row) => {
            const values = row.split(",");
            const pairs = header.map((h, i) => `${h}: ${values[i] !== undefined ? values[i].trim() : ""}`);
            return { pageContent: pairs.join(" | ") } as Document;
          });
          return sanitizeDocs(parsed);
        }
      }
    }
    if (ext === ".xlsx") {
      const PPTXLoader = await getLoader("xlsx");
      return sanitizeDocs(await new PPTXLoader(filePath).load());
    }
    if (ext === ".ppt" || ext === ".pptx") {
      const loaderKey = ext.substring(1);
      const PowerPointLoader = await getLoader(loaderKey);
      try {
        // Try community loader first
        const docs = await new PowerPointLoader(filePath).load();
        
        // Validate and clean the extracted text
        if (docs.length > 0 && !docs.some((d: Document) => /[\uFFFD]/.test(d.pageContent))) {
          return docs.map((doc: Document, idx: number) => ({
            pageContent: doc.pageContent
              .replace(/[^\S\r\n]+/g, ' ')  // normalize spaces
              .replace(/\r?\n/g, '\n')      // normalize newlines
              .trim(),
            metadata: { ...doc.metadata, slideNumber: idx + 1 }
          }));
        }
        throw new Error("PowerPointLoader returned invalid characters");
      } catch (pptErr) {
        // Fallback to manual PPTX parsing
        const errMsg = pptErr instanceof Error ? pptErr.message : String(pptErr);
        if (errMsg.includes("officeparser") || errMsg.toLowerCase().includes("cannot find package") || errMsg.includes("invalid characters")) {
          const JSZipModule = await import("jszip");
          const JSZip = JSZipModule.default ?? JSZipModule;
          const buffer = await fs.readFile(filePath);
          const zip = await JSZip.loadAsync(buffer);
          
          // First try to get slide content
          const slideKeys = Object.keys(zip.files)
            .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
            .sort((a, b) => {
              const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
              const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
              return na - nb;
            });
            
          if (slideKeys.length === 0) {
            throw new Error("No slides found in PPTX file");
          }
          
          const slides = await Promise.all(slideKeys.map(async (key, idx) => {
            const xml = await zip.file(key)!.async("string");
            
            // Extract text from multiple XML elements that might contain content
            const textElements = [
              ...Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)),     // Main text
              ...Array.from(xml.matchAll(/<a:p[^>]*>([\s\S]*?)<\/a:p>/g)),     // Paragraphs
              ...Array.from(xml.matchAll(/<dgm:t[^>]*>([\s\S]*?)<\/dgm:t>/g)), // Diagrams
              ...Array.from(xml.matchAll(/<a:fld[^>]*>([\s\S]*?)<\/a:fld>/g))  // Fields
            ];
            
            // Extract and clean text
            const texts = textElements
              .map(m => m[1])
              .map(text => text
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/\s+/g, ' ')
                .trim()
              )
              .filter(text => text.length > 0);
            
            const slideNum = idx + 1;
            return {
              pageContent: texts.join('\n').trim(),
              metadata: { slideNumber: slideNum, source: key }
            } as Document;
          }));
          
          // Filter out empty slides and return
          return slides.filter(slide => slide.pageContent.length > 0);
        }
        throw new Error(`PowerPoint parsing failed: ${errMsg}`);
      }
    }
    if (ext === ".txt") {
      const TextLoader = await getLoader("txt");
      return sanitizeDocs(await new TextLoader(filePath).load());
    }
    // fallback: plain text
  const raw = await fs.readFile(filePath, "utf8");
  return [{ pageContent: sanitizeText(raw) } as Document];
  } catch (error) {
    throw new Error(`Failed to load ${ext} file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { createChatModel, getModelInfo } from "./model.js";
import { buildQAChain } from "./chain.js";
import { loadDocumentToString, extensionToLoaderType, supportedExtensions } from "./loaders.js";
import { InvokeSchema, InvokeBody, InvokeResult } from "./types.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Serve static files from public directory
app.use(express.static("public"));

// Configure multer for file uploads (no type filtering here; validate with LangChain mapping later)
const upload = multer({
  dest: path.join(os.tmpdir(), "qa-bot-uploads"),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 5 // Maximum 5 files at once
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  const modelInfo = getModelInfo();
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    model: modelInfo
  });
});

app.post("/search/document", async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    console.log(`\n[${requestId}] === NEW REQUEST RECEIVED ===`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Request Body:`, JSON.stringify(req.body, null, 2));

    const parsed = InvokeSchema.parse(req.body as InvokeBody);
    
    console.log(`[${requestId}] Request validated successfully`);
    console.log(`Question: "${parsed.question}"`);
    console.log(`Document source: ${parsed.documentPath ? `File: ${parsed.documentPath}` : `Inline text (${parsed.documentText?.length || 0} chars)`}`);
    console.log(`Prompt type: ${parsed.promptType || 'default'}`);

    const document =
      parsed.documentText ??
      (await loadDocumentToString(parsed.documentPath as string));

    console.log(`[${requestId}] Document loaded: ${document.length} characters`);

    const modelInfo = getModelInfo();
    console.log(`[${requestId}] Using model: ${modelInfo.provider}/${modelInfo.model}`);

    const model = createChatModel();
    const chain = buildQAChain(model, parsed.promptType);

    console.log(`[${requestId}] Processing with QA chain...`);
    const startTime = Date.now();

    const output = await chain.invoke({
      document,
      question: parsed.question
    });

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Chain processing completed in ${duration}ms`);
    console.log(`[${requestId}] Output length: ${output.length} characters`);

    const result: InvokeResult = {
      output,
      model: modelInfo.model,
      provider: modelInfo.provider,
      promptType: parsed.promptType || "default"
    };

    console.log(`📤 [${requestId}] Sending response to client`);
    console.log(`====================================\n`);

    res.json(result);
  } catch (err: any) {
    console.error(`\n[${requestId}] === REQUEST ERROR ===`);
    console.error(`Error:`, err.message ?? String(err));
    console.error(`Stack:`, err.stack);
    console.error(`====================================\n`);

    res.status(400).json({ error: err.message ?? String(err) });
  }
});

// Multi-document search endpoint
type PromptType = 'default' | 'concise' | 'detailed';
type SearchStrategy = 'relevance' | 'chronological';

interface MultiDocRequest {
  question: string;
  promptType?: PromptType;
  maxResults?: number;
  searchStrategy?: SearchStrategy;
}

interface ContentLimits {
  maxChars: number;
  maxDocs: number;
  summaryLength: 'short' | 'medium' | 'full';
}

// Content processing configuration based on prompt type
const CONTENT_LIMITS: Record<PromptType, ContentLimits> = {
  concise: { maxChars: 8000, maxDocs: 3, summaryLength: 'short' },
  default: { maxChars: 16000, maxDocs: 5, summaryLength: 'medium' },
  detailed: { maxChars: 24000, maxDocs: 10, summaryLength: 'full' }
};

// Score document relevance based on query terms and content
function scoreDocument(content: string, query: string): number {
  if (!content || !query) return 0;
  
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const queryTerms = normalizedQuery.split(/\s+/).filter(t => t.length > 2);
  
  let score = 0;
  
  // Term frequency scoring
  for (const term of queryTerms) {
    const count = (normalizedContent.match(new RegExp(term, 'g')) || []).length;
    score += count * 2; // Weight term matches
  }
  
  // Proximity scoring for multi-word queries
  for (let i = 0; i < queryTerms.length - 1; i++) {
    const term1 = queryTerms[i];
    const term2 = queryTerms[i + 1];
    const pos1 = normalizedContent.indexOf(term1);
    const pos2 = normalizedContent.indexOf(term2);
    
    if (pos1 >= 0 && pos2 >= 0) {
      const distance = Math.abs(pos2 - pos1);
      if (distance < 100) { // Close terms get bonus points
        score += (100 - distance) / 20;
      }
    }
  }
  
  // Bonus for early appearance of terms
  const firstMatchPosition = Math.min(
    ...queryTerms
      .map(term => normalizedContent.indexOf(term))
      .filter(pos => pos >= 0)
  );
  if (firstMatchPosition >= 0) {
    score += Math.max(0, 10 - (firstMatchPosition / 100));
  }
  
  return score;
}

app.post("/search/documents", upload.array("files"), async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const uploadedFiles = (req.files ?? []) as Array<{ path: string; originalname: string }>; // avoid Multer type dependency
  try {
    console.log(`\n[${requestId}] === NEW MULTI-DOC REQUEST ===`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Files received: ${uploadedFiles.length}`);

    // Validate and process request parameters
    const promptType = (req.body.promptType || 'default') as PromptType;
    const searchStrategy = (req.body.searchStrategy || 'relevance') as SearchStrategy;
    const maxResults = Math.min(parseInt(req.body.maxResults) || 5, 10);
    const question = req.body.question?.trim();

    if (!question) {
      throw new Error("Question is required");
    }
    if (!uploadedFiles?.length) {
      throw new Error("At least one file is required");
    }

    // Validate extensions based on LangChain loader support instead of Multer mimetypes
    const allowedExts = supportedExtensions();
    const partition = uploadedFiles.reduce((acc, f) => {
      const ext = path.extname(f.originalname).toLowerCase();
      const loaderType = extensionToLoaderType(ext);
      if (loaderType) {
        acc.accepted.push({ file: f, loaderType });
      } else {
        acc.rejected.push({ file: f, reason: `Unsupported extension ${ext}` });
      }
      return acc;
    }, { accepted: [] as Array<{ file: { path: string; originalname: string }; loaderType: string }>, rejected: [] as Array<{ file: { path: string; originalname: string }; reason: string }> });

    if (partition.accepted.length === 0) {
      const rejectedList = partition.rejected.map(r => r.file.originalname).join(", ");
      throw new Error(`No supported files to process. Rejected: [${rejectedList}]. Allowed extensions: ${allowedExts.join(', ')}`);
    }

    // Get content limits based on prompt type
    const limits = CONTENT_LIMITS[promptType];

    // Use LangChain loaders for each file and collect Document objects
    const allDocs: Array<{ name: string; type: string; content: string }> = await Promise.all(
      partition.accepted.map(async ({ file, loaderType }) => {
        try {
          const content = await loadDocumentToString(file.path, { originalName: file.originalname });
          return { name: file.originalname, type: loaderType, content };
        } catch (err) {
          console.error(`Failed to load ${file.originalname}:`, err);
          return { name: file.originalname, type: loaderType, content: "" };
        }
      })
    );

    // Process and enrich documents with metadata
    const flatDocs = allDocs
      .filter(d => d.content && d.content.trim().length > 0)
      .map(d => ({
        pageContent: d.content,
        metadata: {
          filename: d.name,
          source_type: d.type,
          char_count: d.content.length,
          created_at: new Date().toISOString(),
          processed_at: new Date().toISOString(),
          processing_type: promptType
        }
      }));

    if (flatDocs.length === 0) {
      throw new Error("No valid documents could be processed");
    }

    // Process documents based on search strategy and prompt type
    let processedDocs = flatDocs;
    
    // Apply search strategy
    if (searchStrategy === 'relevance') {
      processedDocs = processedDocs
        .map(doc => ({
          doc,
          score: scoreDocument(doc.pageContent, question)
        }))
        .sort((a, b) => b.score - a.score)
        .map(({ doc }) => doc);
    } else {
      // Chronological strategy
      processedDocs = processedDocs.sort((a, b) => {
        const dateA = new Date(a.metadata?.created_at || 0);
        const dateB = new Date(b.metadata?.created_at || 0);
        return dateB.getTime() - dateA.getTime();
      });
    }

    // Apply prompt-type specific processing
    processedDocs = processedDocs.slice(0, limits.maxDocs);
    
    let combinedContent = '';
    let truncated = false;

    switch (promptType) {
      case 'concise':
        // For concise, focus on key points and summaries
        combinedContent = processedDocs
          .map(doc => {
            const summary = doc.pageContent
              .split(/[.!?]+/)
              .filter(s => s.trim().length > 40) // Focus on substantial sentences
              .slice(0, 3) // Take first 3 significant sentences
              .join('. ');
            return `[${doc.metadata?.filename}] ${summary}`;
          })
          .join('\n\n');
        break;
      
      case 'detailed':
        // For detailed, include more context and metadata
        combinedContent = processedDocs
          .map(doc => {
            const content = doc.pageContent;
            const meta = doc.metadata;
            return [
              `[Document: ${meta?.filename}]`,
              `Type: ${meta?.source_type?.toUpperCase()}`,
              `Created: ${meta?.created_at}`,
              `Length: ${meta?.char_count} characters`,
              '',
              content
            ].join('\n');
          })
          .join('\n\n---\n\n');
        break;
      
      default:
        // Standard processing with balanced content
        combinedContent = processedDocs
          .map(doc => `[${doc.metadata?.filename}]\n${doc.pageContent}`)
          .join('\n\n---\n\n');
    }

    // Apply length limits
    if (combinedContent.length > limits.maxChars) {
      combinedContent = combinedContent.slice(0, limits.maxChars);
      truncated = true;
    }

    console.log(`[${requestId}] Documents processed: ${processedDocs.length} of ${flatDocs.length} total`);
    console.log(`[${requestId}] Combined content: ${combinedContent.length} chars`);
    if (truncated) {
      console.log(`[${requestId}] WARNING: Content truncated to ${limits.maxChars} characters.`);
    }
    console.log(`Question: "${question}" (${promptType} mode)`);

    // If there were rejected files, log a non-fatal warning
    if ((uploadedFiles.length - partition.accepted.length) > 0) {
      const rejectedNames = uploadedFiles
        .filter(f => !partition.accepted.some(a => a.file.originalname === f.originalname))
        .map(f => f.originalname);
      console.warn(`[${requestId}] Rejected unsupported files: ${rejectedNames.join(', ')}. Allowed: ${allowedExts.join(', ')}`);
    }

    const modelInfo = getModelInfo();
    const model = createChatModel();
    const chain = buildQAChain(model, promptType);

    console.log(`[${requestId}] Processing with QA chain...`);
    const startTime = Date.now();

    const output = await chain.invoke({
      document: combinedContent,
      question: req.body.question
    });

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Chain processing completed in ${duration}ms`);

    const result: InvokeResult = {
      output,
      model: modelInfo.model,
      provider: modelInfo.provider,
      promptType: "default"
    };

    // Cleanup uploaded files
    await Promise.all(uploadedFiles.map(f => fs.unlink(f.path).catch(() => {})));

    console.log(`📤 [${requestId}] Sending response to client`);
    console.log(`====================================\n`);

    res.json(result);
  } catch (err: any) {
    console.error(`\n[${requestId}] === REQUEST ERROR ===`);
    console.error(`Error:`, err.message ?? String(err));
    console.error(`Stack:`, err.stack);
    console.error(`====================================\n`);

    // Cleanup uploaded files on error
    if (uploadedFiles?.length) {
      await Promise.all(uploadedFiles.map(f => fs.unlink(f.path).catch(() => {})));
    }

    res.status(400).json({ error: err.message ?? String(err) });
  }
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "localhost";
const serverUrl = process.env.SERVER_URL ?? `http://${host}:${port}`;

app.listen(port, () => {
  const modelInfo = getModelInfo();
  console.log(`QA Bot API listening on ${serverUrl}`);
  console.log(`Provider: ${modelInfo.provider}`);
  console.log(`Model: ${modelInfo.model}`);
  console.log(`Temperature: ${modelInfo.temperature}`);
});

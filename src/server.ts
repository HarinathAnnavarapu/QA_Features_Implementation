import "dotenv/config";
import express from "express";
import { createChatModel, getModelInfo } from "./model.js";
import { buildQAChain } from "./chain.js";
import { loadDocumentToString } from "./loaders.js";
import { InvokeSchema, InvokeBody, InvokeResult } from "./types.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

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

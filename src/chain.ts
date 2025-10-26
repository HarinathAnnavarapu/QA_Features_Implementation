import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  ChatPromptTemplate,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate
} from "@langchain/core/prompts";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Runnable } from "@langchain/core/runnables";
import { SYSTEM_PROMPT, HUMAN_PROMPT, PROMPTS, PromptType } from "./prompts.js";

export type QAInputs = { document: string; question: string };

// Cache for compiled chains to avoid rebuilding
const chainCache = new Map<string, Runnable<QAInputs, string>>();

/**
 * Builds an optimized QA chain with caching and configurable prompts
 * @param model - The chat model to use
 * @param promptType - Optional prompt type (default, detailed, concise, technical)
 * @returns A runnable chain that takes QAInputs and returns a string answer
 */
export function buildQAChain(
  model: BaseChatModel,
  promptType: PromptType = "default"
): Runnable<QAInputs, string> {
  const cacheKey = `${model.constructor.name}_${promptType}`;
  
  // Return cached chain if available (for the same model type and prompt)
  if (chainCache.has(cacheKey)) {
    const cachedChain = chainCache.get(cacheKey)!;
    // Recreate chain with new model instance but same prompt structure
    return buildChainInternal(model, promptType);
  }

  const chain = buildChainInternal(model, promptType);
  chainCache.set(cacheKey, chain);
  return chain;
}

/**
 * Internal function to build the actual chain
 */
function buildChainInternal(
  model: BaseChatModel,
  promptType: PromptType
): Runnable<QAInputs, string> {
  const systemPrompt = PROMPTS[promptType] || SYSTEM_PROMPT;
  
  const system = SystemMessagePromptTemplate.fromTemplate(systemPrompt);
  const human = HumanMessagePromptTemplate.fromTemplate(HUMAN_PROMPT);
  const prompt = ChatPromptTemplate.fromMessages([system, human]);

  // Optimized pipeline: prompt -> model -> parser
  return prompt.pipe(model).pipe(new StringOutputParser());
}

/**
 * Clears the chain cache (useful for testing or memory management)
 */
export function clearChainCache(): void {
  chainCache.clear();
}

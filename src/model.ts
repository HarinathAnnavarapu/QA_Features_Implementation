import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

/**
 * Optimized model creation with switch case for all providers
 */
export function createChatModel(): BaseChatModel {
  const provider = (process.env.MODEL_PROVIDER || "groq").toLowerCase().trim();
  const temperature = Number(process.env.TEMPERATURE ?? 0.1);

  // Validate temperature
  if (isNaN(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid temperature: ${process.env.TEMPERATURE}. Must be between 0 and 2.`);
  }

  switch (provider) {
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      const model = process.env.OPENAI_MODEL;

      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required when MODEL_PROVIDER=openai");
      }

      return new ChatOpenAI({
        apiKey,
        model,
        temperature,
      }) as unknown as BaseChatModel;
    }

    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      const model = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022";

      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required when MODEL_PROVIDER=claude");
      }

      return new ChatAnthropic({
        apiKey,
        model,
        temperature,
        maxTokens: Number(process.env.MAX_TOKENS) || 4096
      }) as unknown as BaseChatModel;
    }

    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      const model = process.env.GROQ_MODEL;

      if (!apiKey) {
        throw new Error("GROQ_API_KEY is required when MODEL_PROVIDER=groq");
      }

      return new ChatGroq({
        apiKey,
        model,
        temperature,
      }) as unknown as BaseChatModel;
    }

    default:
      throw new Error(
        `Unsupported MODEL_PROVIDER: "${provider}". ` +
        `Supported providers: openai, claude, groq, `
      );
  }
}

/**
 * Get information about the current model configuration
 */
export function getModelInfo(): {
  provider: string;
  model: string;
  temperature: number;
} {
  const provider = (process.env.MODEL_PROVIDER || "groq").toLowerCase().trim();
  const temperature = Number(process.env.TEMPERATURE ?? 0.1);

  let model = "unknown";
  switch (provider) {
    case "openai":
      model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
      break;
    case "anthropic":
      model = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022";
      break;
    case "groq":
      model = process.env.GROQ_MODEL ?? "meta-llama/llama-4-maverick-17b-128e-instruct";
      break;
  }

  return { provider, model, temperature };
}

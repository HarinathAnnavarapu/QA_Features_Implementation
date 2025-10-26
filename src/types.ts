import { z } from "zod";

export const InvokeSchema = z.object({
  question: z.string().min(1),
  documentPath: z.string().optional(),
  documentText: z.string().optional(),
  promptType: z.enum(["default", "detailed", "concise", "technical"]).optional()
}).refine(v => !!(v.documentPath || v.documentText), {
  message: "Provide either documentPath or documentText"
});

export type InvokeBody = z.infer<typeof InvokeSchema>;

export type InvokeResult = {
  output: string;
  model: string;
  provider: string;
  promptType: string;
};

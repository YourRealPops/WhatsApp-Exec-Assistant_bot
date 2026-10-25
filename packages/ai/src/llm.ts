/** Minimal OpenAI-compatible chat-completions client (works with OpenAI, Z.ai, OpenRouter, …). */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string | null;
  toolCalls: LlmToolCall[];
}

export function hasLlmConfig(cfg?: LlmConfig | null): cfg is LlmConfig {
  return !!cfg?.apiKey && !!cfg?.baseUrl && !!cfg?.model;
}

export async function chat(
  cfg: LlmConfig,
  opts: {
    messages: LlmMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
  },
): Promise<ChatResult> {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: opts.messages,
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    throw new Error(
      `LLM request failed (${res.status}): ${data?.error?.message ?? JSON.stringify(data)}`,
    );
  }
  const message = data?.choices?.[0]?.message ?? {};
  const toolCalls: LlmToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((c: any) => ({
        id: c.id ?? `call_${Math.random().toString(36).slice(2)}`,
        type: "function",
        function: {
          name: c.function?.name ?? "",
          arguments:
            typeof c.function?.arguments === "string"
              ? c.function.arguments
              : JSON.stringify(c.function?.arguments ?? {}),
        },
      }))
    : [];
  return {
    content: typeof message.content === "string" ? message.content : null,
    toolCalls,
  };
}

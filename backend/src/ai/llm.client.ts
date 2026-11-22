import OpenAI from 'openai';

/**
 * Minimal provider-neutral view of one Responses API round.
 * Input/output items follow the OpenAI Responses API shapes (messages, function_call,
 * function_call_output), so the orchestrator can append outputs to the next input.
 */
export type LlmInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      id?: string;
    }
  | { type: 'function_call_output'; call_id: string; output: string }
  // Any other output item from the provider, passed back verbatim (e.g. reasoning).
  | Record<string, unknown>;

export interface LlmTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface LlmFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface LlmRoundResult {
  text: string;
  functionCalls: LlmFunctionCall[];
  /** Raw output items, to be appended to the next round's input. */
  output: LlmInputItem[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface LlmClient {
  readonly model: string;
  round(
    params: {
      instructions: string;
      input: LlmInputItem[];
      tools: LlmTool[];
      maxOutputTokens: number;
      user?: string;
    },
    onTextDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmRoundResult>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');

/** OpenAI Responses API (streaming). The API key never leaves the server. */
export class OpenAiLlmClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async round(
    params: Parameters<LlmClient['round']>[0],
    onTextDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmRoundResult> {
    const stream = await this.client.responses.create(
      {
        model: this.model,
        instructions: params.instructions,
        input: params.input as OpenAI.Responses.ResponseInput,
        tools: params.tools as OpenAI.Responses.Tool[],
        parallel_tool_calls: true,
        max_output_tokens: params.maxOutputTokens,
        // Conversation state lives in our database; nothing is stored at OpenAI.
        store: false,
        stream: true,
        ...(params.user ? { safety_identifier: params.user } : {}),
      },
      signal ? { signal } : undefined,
    );
    let final: OpenAI.Responses.Response | null = null;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') onTextDelta(event.delta);
      else if (event.type === 'response.completed') final = event.response;
      else if (event.type === 'response.failed' || event.type === 'error') {
        const message =
          'response' in event
            ? (event.response.error?.message ?? 'Model request failed')
            : 'Model request failed';
        throw new Error(message);
      } else if (event.type === 'response.incomplete') {
        final = event.response;
      }
    }
    if (!final) throw new Error('Model stream ended without a response');
    const functionCalls: LlmFunctionCall[] = [];
    let text = '';
    for (const item of final.output) {
      if (item.type === 'function_call')
        functionCalls.push({
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      if (item.type === 'message')
        for (const c of item.content)
          if (c.type === 'output_text') text += c.text;
    }
    return {
      text,
      functionCalls,
      output: final.output as unknown as LlmInputItem[],
      usage: {
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0,
        totalTokens: final.usage?.total_tokens ?? 0,
      },
    };
  }
}

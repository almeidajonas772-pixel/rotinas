import Anthropic, { APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { toProviderJsonSchema } from './json-schema';

/**
 * Adaptador de provedor de IA. Hoje há um caminho real de ponta a ponta (Anthropic);
 * outro provedor pode implementar a mesma interface no futuro sem tocar nas rotas.
 */

export interface GenerateRequest {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  json: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export class ProviderError extends Error {
  constructor(
    readonly code: 'provider_error' | 'provider_timeout' | 'refused' | 'invalid_output',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface KaiProvider {
  readonly name: 'anthropic';
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export class AnthropicProvider implements KaiProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey: string, timeoutMs: number) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          // Saída estruturada (JSON Schema). Parâmetro atual: output_config.format — sem cabeçalho beta.
          output_config: { format: { type: 'json_schema', schema: toProviderJsonSchema(request.schema) } },
        },
        { signal: request.signal },
      );
    } catch (error) {
      if (error instanceof APIConnectionTimeoutError) throw new ProviderError('provider_timeout', 'O provedor demorou demais para responder.');
      if (error instanceof APIUserAbortError) throw new ProviderError('provider_timeout', 'Pedido cancelado.');
      if (error instanceof APIError) {
        const status = error.status;
        const msg =
          status === 401 || status === 403
            ? 'A chave da Anthropic foi recusada. Confira ANTHROPIC_API_KEY no servidor.'
            : status === 429
              ? 'O provedor limitou as requisições agora. Tente de novo em instantes.'
              : status === 400
                ? 'O provedor recusou o pedido (configuração de modelo ou formato).'
                : 'O provedor de IA retornou um erro.';
        throw new ProviderError('provider_error', msg, status);
      }
      throw new ProviderError('provider_error', 'Falha de conexão com o provedor de IA.');
    }
    if (message.stop_reason === 'refusal') throw new ProviderError('refused', 'O modelo recusou este pedido.');
    if (message.stop_reason === 'max_tokens') throw new ProviderError('invalid_output', 'A resposta foi cortada por limite de tamanho.');
    const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
    if (!text) throw new ProviderError('invalid_output', 'O provedor não devolveu conteúdo.');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('invalid_output', 'O provedor devolveu um JSON inválido.');
    }
    return { json, model: message.model, usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
  }
}

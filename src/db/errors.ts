import type { z } from 'zod';
import { fieldErrors } from '../domain/schemas';

/** Erro com mensagem pronta para a interface (pt-BR) e, opcionalmente, erros por campo. */
export class UserFacingError extends Error {
  readonly fields?: Record<string, string>;
  constructor(message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'UserFacingError';
    this.fields = fields;
  }
}

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = fieldErrors(result.error);
    const first = Object.values(fields)[0];
    throw new UserFacingError(first ? `Revise os dados: ${first}` : 'Revise os dados informados.', fields);
  }
  return result.data;
}

export function describeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error) {
    if (error.name === 'QuotaExceededError') return 'O armazenamento do navegador está cheio. Exporte um backup e libere espaço.';
    if (error.name === 'InvalidStateError' || error.name === 'DatabaseClosedError') {
      return 'O banco local está indisponível nesta aba. Recarregue a página.';
    }
    if (error.name === 'ConstraintError') return 'Já existe um registro com esses dados.';
  }
  return 'Não foi possível salvar. Tente novamente; se o erro continuar, exporte um backup em Configurações.';
}

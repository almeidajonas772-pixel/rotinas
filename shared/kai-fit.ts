import { z } from 'zod';

/**
 * Converte um esquema Zod no subconjunto de JSON Schema aceito pela saída estruturada
 * da Anthropic (documentação oficial, out/2026): sem limites numéricos, sem minLength/maxLength,
 * sem maxItems, minItems só 0 ou 1, additionalProperties sempre false e só formatos suportados.
 * Os limites removidos continuam valendo: o servidor valida a resposta com o Zod original.
 */

const DROP = new Set(['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'pattern', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties']);
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DROP.has(key)) continue;
    if (key === 'format' && (typeof value !== 'string' || !FORMATS.has(value))) continue;
    if (key === 'minItems' && typeof value === 'number' && value > 1) {
      out.minItems = 1;
      continue;
    }
    out[key] = sanitize(value);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema, { io: 'output' })) as Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

const fullSchemaCache = new WeakMap<z.ZodType, JsonSchema>();

function fullJsonSchema(schema: z.ZodType): JsonSchema {
  let cached = fullSchemaCache.get(schema);
  if (!cached) {
    cached = z.toJSONSchema(schema, { io: 'output' }) as JsonSchema;
    fullSchemaCache.set(schema, cached);
  }
  return cached;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

const INVALID = Symbol('invalid');

function fit(value: unknown, schema: JsonSchema | undefined, inArray: boolean): unknown {
  if (!schema) return value;
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf as JsonSchema[];
    const allowsNull = options.some((o) => o.type === 'null');
    if (value === null && allowsNull) return null;
    const main = options.find((o) => o.type !== 'null');
    const fitted = fit(value, main, inArray);
    return fitted === INVALID && allowsNull ? null : fitted;
  }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return INVALID;
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(props)) {
        if (!(key in value)) {
          if (required.has(key)) return INVALID;
          continue;
        }
        const fitted = fit((value as Record<string, unknown>)[key], sub, false);
        if (fitted === INVALID) {
          if (required.has(key)) return INVALID;
          continue;
        }
        out[key] = fitted;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return INVALID;
      let items = value.map((v) => fit(v, schema.items as JsonSchema | undefined, true)).filter((v) => v !== INVALID);
      if (typeof schema.maxItems === 'number') items = items.slice(0, schema.maxItems);
      if (typeof schema.minItems === 'number' && items.length < schema.minItems) return INVALID;
      return items;
    }
    case 'string': {
      if (typeof value !== 'string') return INVALID;
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return INVALID;
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return INVALID;
      if (typeof schema.minLength === 'number' && value.trim().length < schema.minLength) return INVALID;
      return typeof schema.maxLength === 'number' ? truncate(value, schema.maxLength) : value;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID;
      if (schema.type === 'integer' && !Number.isInteger(value)) return INVALID;
      const min = typeof schema.minimum === 'number' ? schema.minimum : -Infinity;
      const max = typeof schema.maximum === 'number' ? schema.maximum : Infinity;
      if (value >= min && value <= max) return value;
      // Em listas (ex.: dias da semana) um valor fora do intervalo é descartado; isolado, é limitado.
      return inArray ? INVALID : Math.min(max, Math.max(min, value));
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : INVALID;
    default:
      return value;
  }
}

/**
 * Ajusta a saída do provedor aos limites que o JSON Schema enviado não consegue impor
 * (maxItems, maxLength, pattern, minimum/maximum). Não cria conteúdo: corta excessos,
 * descarta itens fora do formato (um item inválido some da lista; um campo opcional
 * inválido vira null) e, se algo obrigatório estiver inválido, devolve `undefined`
 * — o chamador trata isso como resposta inválida, nunca como dado.
 */
export function fitToSchema(value: unknown, schema: z.ZodType): unknown {
  const fitted = fit(value, fullJsonSchema(schema), false);
  return fitted === INVALID ? undefined : fitted;
}

/** Lista palavras-chave não suportadas que restaram (usado nos testes). */
export function unsupportedKeywords(schema: unknown, path = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(schema)) schema.forEach((s, i) => found.push(...unsupportedKeywords(s, `${path}[${i}]`)));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (DROP.has(k)) found.push(`${path}.${k}`);
      if (k === 'minItems' && typeof v === 'number' && v > 1) found.push(`${path}.minItems`);
      if (k === 'additionalProperties' && v !== false) found.push(`${path}.additionalProperties`);
      found.push(...unsupportedKeywords(v, `${path}.${k}`));
    }
  }
  return found;
}

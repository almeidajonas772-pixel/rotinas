import { categoryKey } from '../domain/money';
import { budgetSchema, cleanText, moneyEntrySchema, type MoneyEntry, type MoneyKind, type Necessity, type PaymentMethod } from '../domain/schemas';
import { db, newId, nowIso, type RotinasDB } from './db';
import { validate } from './errors';

/** Gastos, entradas e limites mensais. Toda escrita é validada; valores sempre em centavos. */

export interface MoneyDraft {
  kind: MoneyKind;
  amountCents: number;
  date: string;
  category: string;
  description?: string;
  method?: PaymentMethod;
  necessity?: Necessity;
}

/** Cria (sem `id`) ou atualiza um lançamento, mantendo a data de criação original. */
export async function saveMoneyEntry(draft: MoneyDraft, id?: string, database: RotinasDB = db): Promise<MoneyEntry> {
  const now = nowIso();
  const existing = id ? await database.moneyEntries.get(id) : undefined;
  const entry = validate(moneyEntrySchema, {
    id: existing?.id ?? newId(),
    kind: draft.kind,
    amountCents: draft.amountCents,
    date: draft.date,
    category: draft.category.trim(),
    description: cleanText(draft.description),
    // Forma de pagamento e necessidade só fazem sentido para gastos.
    method: draft.kind === 'expense' ? draft.method : undefined,
    necessity: draft.kind === 'expense' ? draft.necessity : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await database.moneyEntries.put(entry);
  return entry;
}

export async function deleteMoneyEntry(id: string, database: RotinasDB = db): Promise<void> {
  await database.moneyEntries.delete(id);
}

/** Define (ou, com `null`, remove) o limite mensal de gastos de uma categoria. */
export async function setBudget(category: string, monthlyLimitCents: number | null, database: RotinasDB = db): Promise<void> {
  const id = categoryKey(category);
  if (monthlyLimitCents === null) {
    await database.budgets.delete(id);
    return;
  }
  await database.budgets.put(validate(budgetSchema, { id, category: category.trim(), monthlyLimitCents, updatedAt: nowIso() }));
}

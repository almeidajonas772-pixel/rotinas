import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportBackup, parseBackup, restoreBackup } from '../../src/db/backup';
import { RotinasDB } from '../../src/db/db';
import { UserFacingError } from '../../src/db/errors';
import { deleteMoneyEntry, saveMoneyEntry, setBudget } from '../../src/db/repo-money';
import {
  budgetStatus,
  byCategory,
  categoryKey,
  categoryOptions,
  dailySeries,
  formatMoney,
  formatMoneyCompact,
  monthlySeries,
  monthProjection,
  moneyCsv,
  moneyInsights,
  moneyPeriod,
  moneyTotals,
  parseMoney,
  shiftAnchor,
  yearlySeries,
} from '../../src/domain/money';
import type { Budget, MoneyEntry } from '../../src/domain/schemas';
import { defaultDocId } from '../../src/sync/layout';

const nb = (s: string) => s.replace(/\u00a0/g, ' ');

let n = 0;
function entry(kind: MoneyEntry['kind'], reais: number, date: string, category: string, extra: Partial<MoneyEntry> = {}): MoneyEntry {
  n += 1;
  return { id: `m${n}`, kind, amountCents: Math.round(reais * 100), date, category, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', ...extra };
}

describe('valores', () => {
  it('lê valores do jeito que se digita no Brasil (e alguns outros)', () => {
    expect(parseMoney('12,50')).toBe(1250);
    expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('12.50')).toBe(1250);
    expect(parseMoney('1.234,56')).toBe(123456);
    expect(parseMoney('1.234')).toBe(123400);
    expect(parseMoney('R$ 25')).toBe(2500);
    expect(parseMoney(' 0,99 ')).toBe(99);
    expect(parseMoney('12,')).toBe(1200);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });

  it('formata em reais e em forma curta para eixos', () => {
    expect(nb(formatMoney(123456))).toBe('R$ 1.234,56');
    expect(nb(formatMoney(-5000))).toBe('-R$ 50,00');
    expect(formatMoneyCompact(35000)).toBe('R$ 350');
    expect(nb(formatMoneyCompact(123456))).toBe('R$ 1,2 mil');
  });

  it('normaliza nomes de categoria', () => {
    expect(categoryKey(' Alimentação ')).toBe('alimentacao');
    expect(categoryKey('Lazer & Festas')).toBe('lazer-festas');
    expect(categoryKey('!!!')).toBe('outros');
  });
});

describe('relatórios', () => {
  const entries = [
    entry('income', 500, '2026-10-01', 'Mesada'),
    entry('expense', 120, '2026-10-02', 'Alimentação'),
    entry('expense', 80, '2026-10-05', 'alimentacao', { necessity: 'superfluo' }),
    entry('expense', 60, '2026-10-05', 'Transporte', { necessity: 'essencial' }),
    entry('expense', 15, '2026-10-06', 'Lazer'),
    entry('expense', 100, '2026-09-10', 'Alimentação'),
    entry('expense', 300, '2025-03-01', 'Viagem'),
    entry('income', 900, '2025-12-20', 'Vendas'),
  ];
  const october = entries.filter((e) => e.date.startsWith('2026-10'));
  const september = entries.filter((e) => e.date.startsWith('2026-09'));

  it('períodos de mês e ano, com o período anterior para comparar', () => {
    const m = moneyPeriod('month', '2026-10-21');
    expect(m).toMatchObject({ start: '2026-10-01', end: '2026-10-31', label: 'outubro de 2026', prev: { start: '2026-09-01', end: '2026-09-30', label: 'setembro' } });
    const y = moneyPeriod('year', '2026-10-21');
    expect(y).toMatchObject({ start: '2026-01-01', end: '2026-12-31', label: '2026', prev: { label: '2025' } });
    expect(shiftAnchor('month', '2026-01-31', -1)).toBe('2025-12-01');
    expect(shiftAnchor('year', '2026-10-21', 1)).toBe('2027-01-01');
  });

  it('totais e ranking por categoria (acentos e maiúsculas não separam categorias)', () => {
    expect(moneyTotals(october)).toEqual({ income: 50000, expense: 27500, balance: 22500, count: 5 });
    const cats = byCategory(october);
    expect(cats.map((c) => [c.category, c.cents, c.count])).toEqual([
      ['Alimentação', 20000, 2],
      ['Transporte', 6000, 1],
      ['Lazer', 1500, 1],
    ]);
    expect(cats[0].share).toBeCloseTo(20000 / 27500);
    expect(categoryOptions(entries, 'expense').slice(0, 2)).toEqual(['Alimentação', 'Transporte']);
  });

  it('séries por dia, por mês e por ano', () => {
    const days = dailySeries(october, '2026-10-01', '2026-10-31');
    expect(days).toHaveLength(31);
    expect(days[4]).toMatchObject({ label: '5', expense: 14000 });
    const months = monthlySeries(entries, 2026);
    expect(months[9]).toMatchObject({ label: 'out', income: 50000, expense: 27500 });
    expect(months[8].expense).toBe(10000);
    const years = yearlySeries(entries);
    expect(years.map((p) => [p.label, p.income, p.expense])).toEqual([
      ['2025', 90000, 30000],
      ['2026', 50000, 37500],
    ]);
  });

  it('projeção do mês só no mês atual e com pelo menos 3 dias corridos', () => {
    const period = moneyPeriod('month', '2026-10-10');
    expect(monthProjection(10000, '2026-10-10', period)).toBe(31000);
    expect(monthProjection(10000, '2026-10-02', period)).toBeNull();
    expect(monthProjection(10000, '2026-11-02', period)).toBeNull();
  });

  it('limites mensais: quanto já foi usado e o que passou', () => {
    const budgets: Budget[] = [
      { id: 'alimentacao', category: 'Alimentação', monthlyLimitCents: 15000, updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'lazer', category: 'Lazer', monthlyLimitCents: 10000, updatedAt: '2026-10-01T00:00:00.000Z' },
    ];
    expect(budgetStatus(october, budgets).map((b) => [b.category, b.spent, b.over])).toEqual([
      ['Alimentação', 20000, true],
      ['Lazer', 1500, false],
    ]);
  });

  it('observações: limite estourado, saldo, maior categoria, alta vs mês anterior, supérfluos e formiguinha', () => {
    const budgets: Budget[] = [{ id: 'alimentacao', category: 'Alimentação', monthlyLimitCents: 15000, updatedAt: '2026-10-01T00:00:00.000Z' }];
    const smalls = Array.from({ length: 5 }, (_, i) => entry('expense', 9, `2026-10-0${i + 1}`, 'Lanches'));
    const insights = moneyInsights({ period: moneyPeriod('month', '2026-10-21'), current: [...october, ...smalls], previous: september, budgets, today: '2026-10-21' }).map((i) => [i.tone, nb(i.text)]);
    expect(insights[0]).toEqual(['danger', 'Passou do limite de Alimentação em R$ 50,00 (gastou R$ 200,00 de R$ 150,00).']);
    expect(insights).toContainEqual(['ok', 'Sobrou R$ 180,00 — 36% do que entrou.']);
    expect(insights).toContainEqual(['warn', 'Alimentação foi para onde mais foi dinheiro: R$ 200,00 (63% dos gastos).']);
    expect(insights).toContainEqual(['warn', 'Alimentação subiu 100% em relação a setembro (+R$ 100,00).']);
    expect(insights).toContainEqual(['warn', 'No total, você gastou 220% a mais que em setembro.']);
    expect(insights).toContainEqual(['warn', 'Gastos que você marcou como supérfluos: R$ 80,00 (57% dos gastos classificados).']);
    expect(insights.some(([, t]) => t.startsWith('6 gastos pequenos'))).toBe(true);
    expect(insights.some(([, t]) => t.startsWith('No ritmo atual, o mês fecha com cerca de'))).toBe(true);
  });

  it('sem lançamentos no período, nenhuma observação inventada', () => {
    expect(moneyInsights({ period: moneyPeriod('month', '2026-11-05'), current: [], previous: october, budgets: [], today: '2026-11-05' })).toEqual([]);
  });

  it('planilha CSV para Excel e Google Planilhas em português', () => {
    const csv = moneyCsv([entry('expense', 12.5, '2026-10-02', 'Alimentação', { description: 'Lanche; "grande"', method: 'pix' }), entry('income', 50, '2026-10-01', 'Mesada')]);
    const lines = csv.replace(/^\ufeff/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Data;Tipo;Categoria;Descrição;Forma de pagamento;Necessidade;Valor (R$)');
    expect(lines[1]).toBe('01/10/2026;Entrada;Mesada;;;;50,00');
    expect(lines[2]).toBe('02/10/2026;Gasto;Alimentação;"Lanche; ""grande""";Pix;;-12,50');
  });

  it('pacote de sincronização por mês', () => {
    expect(defaultDocId('moneyEntries', 'x', { date: '2026-10-05' })).toBe('c~moneyEntries~2026-10');
    expect(defaultDocId('budgets', 'alimentacao', null)).toBe('c~budgets');
  });
});

describe('repositório e backup', () => {
  let database: RotinasDB;
  beforeEach(() => {
    database = new RotinasDB(`money-${crypto.randomUUID()}`);
  });
  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it('valida, guarda a criação original, limpa campos de gasto em entradas e exclui', async () => {
    await expect(saveMoneyEntry({ kind: 'expense', amountCents: 0, date: '2026-10-21', category: 'Lazer' }, undefined, database)).rejects.toBeInstanceOf(UserFacingError);
    const created = await saveMoneyEntry({ kind: 'expense', amountCents: 1250, date: '2026-10-21', category: ' Lazer ', description: '  ', method: 'pix', necessity: 'superfluo' }, undefined, database);
    expect(created).toMatchObject({ category: 'Lazer', method: 'pix', necessity: 'superfluo' });
    expect(created.description).toBeUndefined();
    const updated = await saveMoneyEntry({ kind: 'income', amountCents: 5000, date: '2026-10-21', category: 'Vendas', method: 'pix', necessity: 'superfluo' }, created.id, database);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.method).toBeUndefined();
    expect(updated.necessity).toBeUndefined();
    await deleteMoneyEntry(created.id, database);
    expect(await database.moneyEntries.count()).toBe(0);
  });

  it('limites por categoria (null remove) e backup com dinheiro', async () => {
    await setBudget('Alimentação', 30000, database);
    await setBudget('Lazer', 10000, database);
    await setBudget('Lazer', null, database);
    expect((await database.budgets.toArray()).map((b) => [b.id, b.monthlyLimitCents])).toEqual([['alimentacao', 30000]]);
    await saveMoneyEntry({ kind: 'expense', amountCents: 4590, date: '2026-10-20', category: 'Alimentação' }, undefined, database);

    const parsed = parseBackup(JSON.stringify(await exportBackup(database)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.counts).toMatchObject({ moneyEntries: 1, budgets: 1 });
    const other = new RotinasDB(`money-${crypto.randomUUID()}`);
    await restoreBackup(parsed.backup, other);
    expect(await other.moneyEntries.count()).toBe(1);
    expect((await other.budgets.get('alimentacao'))?.monthlyLimitCents).toBe(30000);
    other.close();
    await other.delete();
  });

  it('backups antigos (sem a aba Dinheiro) continuam válidos', async () => {
    const file = await exportBackup(database);
    const old = { ...file, schemaVersion: 3, tables: { ...file.tables } as Record<string, unknown> };
    delete old.tables.moneyEntries;
    delete old.tables.budgets;
    const parsed = parseBackup(JSON.stringify(old));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.backup.counts.moneyEntries).toBe(0);
  });
});

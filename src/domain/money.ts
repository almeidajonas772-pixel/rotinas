import { addDays, addMonths, diffDays, endOfMonth, endOfYear, parseCivil, startOfMonth, startOfYear, type CivilDate } from './civil';
import { formatMonthYear, monthName, monthShort } from './format';
import type { Budget, MoneyEntry, MoneyKind, Necessity, PaymentMethod } from './schemas';

/**
 * Regras da aba Dinheiro: valores sempre em centavos inteiros, períodos por mês e por ano,
 * totais, ranking por categoria, séries para os gráficos e observações calculadas (sem IA).
 */

export const EXPENSE_CATEGORIES = [
  'Alimentação',
  'Mercado',
  'Transporte',
  'Moradia',
  'Contas',
  'Saúde',
  'Educação',
  'Lazer',
  'Compras',
  'Roupas',
  'Assinaturas',
  'Presentes',
  'Viagem',
  'Negócios',
  'Outros',
] as const;

export const INCOME_CATEGORIES = ['Mesada', 'Trabalho', 'Vendas', 'Serviços', 'Negócios', 'Investimentos', 'Presentes', 'Outros'] as const;

export const KIND_LABEL: Record<MoneyKind, string> = { expense: 'Gasto', income: 'Entrada' };
export const PAYMENT_LABEL: Record<PaymentMethod, string> = { pix: 'Pix', debito: 'Débito', credito: 'Crédito', dinheiro: 'Dinheiro', boleto: 'Boleto', outro: 'Outro' };
export const NECESSITY_LABEL: Record<Necessity, string> = { essencial: 'Essencial', importante: 'Importante', superfluo: 'Supérfluo' };

/** Gasto "pequeno" para o efeito formiguinha (até R$ 30). */
export const SMALL_EXPENSE_CENTS = 3000;

// ── Valores ─────────────────────────────────────────────────────────────────

/**
 * Lê um valor digitado ("12,50", "12.50", "1.234,56", "R$ 25") e devolve centavos.
 * Vírgula ou ponto seguidos de 1–2 dígitos no fim são decimais; os demais separadores, milhares.
 * Devolve `null` para texto que não é um valor.
 */
export function parseMoney(input: string): number | null {
  const t = input.trim().replace(/^R\$/i, '').replace(/[\s\u00a0]/g, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  let integer = t;
  let fraction = '';
  const comma = t.lastIndexOf(',');
  const dot = t.lastIndexOf('.');
  const sep = comma >= 0 ? comma : dot;
  if (sep >= 0) {
    const after = t.slice(sep + 1);
    const single = comma >= 0 ? t.indexOf(',') === comma && dot < comma : t.indexOf('.') === dot;
    if (single && /^\d{1,2}$/.test(after)) {
      integer = t.slice(0, sep);
      fraction = after;
    }
  }
  integer = integer.replace(/[.,]/g, '');
  if (!/^\d+$/.test(integer) || integer.length > 9) return null;
  return Number(integer) * 100 + Number(`${fraction}00`.slice(0, 2));
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const COMPACT = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

/** "R$ 1.234,56" */
export function formatMoney(cents: number): string {
  return BRL.format(cents / 100);
}

/** "R$ 1,2 mil" — para eixos de gráfico. */
export function formatMoneyCompact(cents: number): string {
  const reais = cents / 100;
  return `R$ ${Math.abs(reais) < 1000 ? Math.round(reais).toLocaleString('pt-BR') : COMPACT.format(reais)}`;
}

/** Valor para digitar de novo no campo: 1250 → "12,50". */
export function moneyInputValue(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** Nome de categoria normalizado (para limites e agrupamento): "Alimentação " → "alimentacao". */
export function categoryKey(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'outros'
  );
}

/** Variação percentual arredondada (null quando não há base de comparação). */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// ── Períodos ────────────────────────────────────────────────────────────────

export type MoneyView = 'month' | 'year' | 'years';

export interface MoneyPeriod {
  view: MoneyView;
  start: CivilDate;
  end: CivilDate;
  label: string;
  prev?: { start: CivilDate; end: CivilDate; label: string };
}

export function moneyPeriod(view: MoneyView, anchor: CivilDate): MoneyPeriod {
  if (view === 'month') {
    const start = startOfMonth(anchor);
    const prevStart = addMonths(start, -1);
    return { view, start, end: endOfMonth(anchor), label: formatMonthYear(start), prev: { start: prevStart, end: endOfMonth(prevStart), label: monthName(parseCivil(prevStart).m) } };
  }
  if (view === 'year') {
    const start = startOfYear(anchor);
    const prevStart = startOfYear(addDays(start, -1));
    return { view, start, end: endOfYear(anchor), label: String(parseCivil(start).y), prev: { start: prevStart, end: endOfYear(prevStart), label: String(parseCivil(prevStart).y) } };
  }
  return { view, start: '1900-01-01', end: '9999-12-31', label: 'Todos os anos' };
}

/** Âncora do período anterior/seguinte. */
export function shiftAnchor(view: MoneyView, anchor: CivilDate, step: -1 | 1): CivilDate {
  return view === 'month' ? addMonths(startOfMonth(anchor), step) : view === 'year' ? addMonths(startOfYear(anchor), step * 12) : anchor;
}

export function inPeriod(entries: readonly MoneyEntry[], start: CivilDate, end: CivilDate): MoneyEntry[] {
  return entries.filter((e) => e.date >= start && e.date <= end);
}

// ── Totais e rankings ───────────────────────────────────────────────────────

export interface MoneyTotals {
  income: number;
  expense: number;
  balance: number;
  count: number;
}

export function moneyTotals(entries: readonly MoneyEntry[]): MoneyTotals {
  let income = 0;
  let expense = 0;
  for (const e of entries) {
    if (e.kind === 'income') income += e.amountCents;
    else expense += e.amountCents;
  }
  return { income, expense, balance: income - expense, count: entries.length };
}

export interface CategoryTotal {
  key: string;
  category: string;
  cents: number;
  count: number;
  /** Fração do total do tipo no período (0–1). */
  share: number;
}

/** Total por categoria de um tipo, do maior para o menor. Nomes iguais com acentos/caixa diferentes se juntam. */
export function byCategory(entries: readonly MoneyEntry[], kind: MoneyKind = 'expense'): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>();
  let total = 0;
  for (const e of entries) {
    if (e.kind !== kind) continue;
    total += e.amountCents;
    const key = categoryKey(e.category);
    const cur = map.get(key) ?? { key, category: e.category.trim(), cents: 0, count: 0, share: 0 };
    cur.cents += e.amountCents;
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()].map((c) => ({ ...c, share: total > 0 ? c.cents / total : 0 })).sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category, 'pt-BR'));
}

/** Categorias já usadas (mais usadas primeiro), seguidas das sugeridas que faltam. */
export function categoryOptions(entries: readonly MoneyEntry[], kind: MoneyKind): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const e of entries) {
    if (e.kind !== kind) continue;
    const key = categoryKey(e.category);
    const cur = counts.get(key) ?? { name: e.category.trim(), n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  const used = [...counts.values()].sort((a, b) => b.n - a.n).map((c) => c.name);
  const presets = (kind === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES).filter((p) => !counts.has(categoryKey(p)));
  return [...used, ...presets];
}

// ── Séries para os gráficos ─────────────────────────────────────────────────

export interface MoneyPoint {
  label: string;
  fullLabel: string;
  income: number;
  expense: number;
}

/** Um ponto por dia do período (para a visão do mês). */
export function dailySeries(entries: readonly MoneyEntry[], start: CivilDate, end: CivilDate): MoneyPoint[] {
  const days = diffDays(end, start) + 1;
  const points: MoneyPoint[] = Array.from({ length: Math.max(0, days) }, (_, i) => {
    const d = addDays(start, i);
    const { m, d: day } = parseCivil(d);
    return { label: String(day), fullLabel: `${day} de ${monthName(m)}`, income: 0, expense: 0 };
  });
  for (const e of entries) {
    const i = diffDays(e.date, start);
    if (i < 0 || i >= points.length) continue;
    points[i][e.kind] += e.amountCents;
  }
  return points;
}

/** Doze pontos, de janeiro a dezembro do ano. */
export function monthlySeries(entries: readonly MoneyEntry[], year: number): MoneyPoint[] {
  const points: MoneyPoint[] = Array.from({ length: 12 }, (_, i) => ({ label: monthShort(i + 1), fullLabel: `${monthName(i + 1)} de ${year}`, income: 0, expense: 0 }));
  for (const e of entries) {
    const { y, m } = parseCivil(e.date);
    if (y === year) points[m - 1][e.kind] += e.amountCents;
  }
  return points;
}

/** Um ponto por ano, do primeiro ao último com lançamentos (anos sem lançamentos aparecem zerados). */
export function yearlySeries(entries: readonly MoneyEntry[]): MoneyPoint[] {
  if (entries.length === 0) return [];
  const years = entries.map((e) => parseCivil(e.date).y);
  const first = Math.min(...years);
  const last = Math.max(...years);
  const points: MoneyPoint[] = [];
  for (let y = first; y <= last; y++) points.push({ label: String(y), fullLabel: String(y), income: 0, expense: 0 });
  for (const e of entries) points[parseCivil(e.date).y - first][e.kind] += e.amountCents;
  return points;
}

/**
 * Projeção simples do gasto do mês atual: o gasto até hoje mais a média diária × os dias que faltam.
 * A média conta a partir do primeiro lançamento (quem começou a anotar no meio do mês não tem os
 * dias anteriores zerados). Só com 3 ou mais dias de registro.
 */
export function monthProjection(expenseSoFar: number, today: CivilDate, period: MoneyPeriod, firstEntry?: CivilDate): number | null {
  if (period.view !== 'month' || today < period.start || today > period.end) return null;
  const from = firstEntry && firstEntry > period.start ? firstEntry : period.start;
  if (from > today) return null;
  const elapsed = diffDays(today, from) + 1;
  if (elapsed < 3) return null;
  return Math.round(expenseSoFar + (expenseSoFar / elapsed) * diffDays(period.end, today));
}

// ── Limites ─────────────────────────────────────────────────────────────────

export interface BudgetStatus {
  key: string;
  category: string;
  limit: number;
  spent: number;
  ratio: number;
  over: boolean;
}

/** Situação de cada limite mensal no mês informado (gastos da categoria no mês × limite). */
export function budgetStatus(monthEntries: readonly MoneyEntry[], budgets: readonly Budget[]): BudgetStatus[] {
  const spentBy = new Map(byCategory(monthEntries, 'expense').map((c) => [c.key, c.cents]));
  return budgets
    .map((b) => {
      const spent = spentBy.get(b.id) ?? 0;
      return { key: b.id, category: b.category, limit: b.monthlyLimitCents, spent, ratio: spent / b.monthlyLimitCents, over: spent > b.monthlyLimitCents };
    })
    .sort((a, b) => b.ratio - a.ratio);
}

// ── Observações (calculadas, sem IA) ────────────────────────────────────────

export interface MoneyInsight {
  tone: 'danger' | 'warn' | 'ok' | 'info';
  text: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * O que chama atenção no período, em ordem de importância: limites estourados, gasto maior que as
 * entradas, para onde mais foi dinheiro, o que mais cresceu em relação ao período anterior,
 * supérfluos, efeito formiguinha e projeção do mês. Tudo vem dos lançamentos; nada é estimado
 * além da projeção (identificada como tal).
 */
export function moneyInsights(input: {
  period: MoneyPeriod;
  current: readonly MoneyEntry[];
  previous: readonly MoneyEntry[];
  budgets: readonly Budget[];
  today: CivilDate;
  /** Data do primeiro lançamento de todos (para a projeção não contar dias antes de começar a anotar). */
  firstEntry?: CivilDate;
}): MoneyInsight[] {
  const { period, current, previous } = input;
  const out: MoneyInsight[] = [];
  const totals = moneyTotals(current);
  if (totals.expense === 0 && totals.income === 0) return out;
  const cats = byCategory(current, 'expense');

  if (period.view === 'month') {
    for (const b of budgetStatus(current, input.budgets)) {
      if (b.over) out.push({ tone: 'danger', text: `Passou do limite de ${b.category} em ${formatMoney(b.spent - b.limit)} (gastou ${formatMoney(b.spent)} de ${formatMoney(b.limit)}).` });
      else if (b.ratio >= 0.8) out.push({ tone: 'warn', text: `${b.category} já usou ${pct(b.ratio)} do limite do mês (${formatMoney(b.spent)} de ${formatMoney(b.limit)}).` });
    }
  }

  if (totals.income > 0 && totals.expense > totals.income) {
    out.push({ tone: 'danger', text: `Você gastou ${formatMoney(totals.expense - totals.income)} a mais do que entrou neste período.` });
  } else if (totals.income > 0) {
    out.push({ tone: 'ok', text: `Sobrou ${formatMoney(totals.balance)} — ${pct(totals.balance / totals.income)} do que entrou.` });
  }

  if (cats.length > 0 && totals.expense > 0) {
    const top = cats[0];
    out.push({ tone: top.share >= 0.4 ? 'warn' : 'info', text: `${top.category} foi para onde mais foi dinheiro: ${formatMoney(top.cents)} (${pct(top.share)} dos gastos).` });
  }

  if (period.prev) {
    const prevTotals = moneyTotals(previous);
    const prevCats = new Map(byCategory(previous, 'expense').map((c) => [c.key, c.cents]));
    let biggest: { cat: CategoryTotal; diff: number; before: number } | null = null;
    for (const c of cats) {
      const before = prevCats.get(c.key) ?? 0;
      const diff = c.cents - before;
      if (diff >= 2000 && (before === 0 || diff / before >= 0.2) && (!biggest || diff > biggest.diff)) biggest = { cat: c, diff, before };
    }
    // Sem gastos no período anterior (ex.: começo do uso), comparar categorias não diz nada.
    if (biggest && prevTotals.expense > 0) {
      out.push({
        tone: 'warn',
        text:
          biggest.before > 0
            ? `${biggest.cat.category} subiu ${percentChange(biggest.cat.cents, biggest.before)}% em relação a ${period.prev.label} (+${formatMoney(biggest.diff)}).`
            : `${biggest.cat.category}: ${formatMoney(biggest.cat.cents)} — em ${period.prev.label} não houve gasto nessa categoria.`,
      });
    }
    const change = percentChange(totals.expense, prevTotals.expense);
    if (change !== null && Math.abs(change) >= 5) {
      out.push({ tone: change > 0 ? 'warn' : 'ok', text: `No total, você gastou ${Math.abs(change)}% ${change > 0 ? 'a mais' : 'a menos'} que em ${period.prev.label}.` });
    }
  }

  const tagged = current.filter((e) => e.kind === 'expense' && e.necessity);
  if (tagged.length > 0) {
    const superfluous = tagged.filter((e) => e.necessity === 'superfluo').reduce((s, e) => s + e.amountCents, 0);
    const taggedTotal = tagged.reduce((s, e) => s + e.amountCents, 0);
    if (superfluous > 0) {
      const share = superfluous / taggedTotal;
      out.push({ tone: share >= 0.25 ? 'warn' : 'info', text: `Gastos que você marcou como supérfluos: ${formatMoney(superfluous)} (${pct(share)} dos gastos classificados).` });
    }
  }

  const small = current.filter((e) => e.kind === 'expense' && e.amountCents <= SMALL_EXPENSE_CENTS);
  const smallTotal = small.reduce((s, e) => s + e.amountCents, 0);
  if (small.length >= 5 && totals.expense > 0 && smallTotal / totals.expense >= 0.1) {
    out.push({ tone: 'warn', text: `${small.length} gastos pequenos (até ${formatMoney(SMALL_EXPENSE_CENTS)}) somaram ${formatMoney(smallTotal)} — o efeito formiguinha.` });
  }

  const projection = monthProjection(totals.expense, input.today, period, input.firstEntry);
  if (projection !== null && projection > totals.expense) {
    out.push({ tone: 'info', text: `No ritmo atual, o mês fecha com cerca de ${formatMoney(projection)} em gastos (projeção pela média diária).` });
  }
  return out.slice(0, 8);
}

// ── Exportação ──────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  return /[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV no formato que o Excel e o Google Planilhas em português abrem direto (";" e vírgula decimal). */
export function moneyCsv(entries: readonly MoneyEntry[]): string {
  const header = ['Data', 'Tipo', 'Categoria', 'Descrição', 'Forma de pagamento', 'Necessidade', 'Valor (R$)'];
  const rows = [...entries]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((e) => {
      const { y, m, d } = parseCivil(e.date);
      const signed = (e.kind === 'income' ? e.amountCents : -e.amountCents) / 100;
      return [
        `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`,
        KIND_LABEL[e.kind],
        e.category,
        e.description ?? '',
        e.method ? PAYMENT_LABEL[e.method] : '',
        e.necessity ? NECESSITY_LABEL[e.necessity] : '',
        signed.toFixed(2).replace('.', ','),
      ].map(csvCell);
    });
  return `\ufeff${[header, ...rows].map((r) => r.join(';')).join('\r\n')}\r\n`;
}

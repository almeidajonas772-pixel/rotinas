import { AlertTriangle, ChevronLeft, ChevronRight, CircleCheck, Download, Info, Plus, Target, TrendingUp, Wallet } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../../app/context';
import { ChartFrame, ColumnChart, MeterList, type MeterRow } from '../../components/charts';
import { Segmented, SelectField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, EmptyState, IconButton, LoadingState, PageHeader, Section, Stat, Tag } from '../../components/ui';
import { useBudgets, useMoneyEntries } from '../../db/hooks';
import { diffDays, parseCivil } from '../../domain/civil';
import { formatLongDate, plural } from '../../domain/format';
import {
  budgetStatus,
  byCategory,
  categoryKey,
  dailySeries,
  formatMoney,
  formatMoneyCompact,
  inPeriod,
  monthlySeries,
  monthProjection,
  moneyCsv,
  moneyInsights,
  moneyPeriod,
  moneyTotals,
  NECESSITY_LABEL,
  PAYMENT_LABEL,
  percentChange,
  shiftAnchor,
  yearlySeries,
  type MoneyInsight,
  type MoneyView,
} from '../../domain/money';
import type { MoneyEntry, MoneyKind } from '../../domain/schemas';
import { downloadProblem, downloadText, useUiPref } from '../../lib/browser';
import { BudgetsDialog } from './BudgetsDialog';
import { MoneyEntryDialog } from './MoneyEntryDialog';

const INCOME_COLOR = 'var(--chart-series-1)';
const EXPENSE_COLOR = 'var(--chart-series-2)';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const INSIGHT_ICON: Record<MoneyInsight['tone'], ReactNode> = {
  danger: <AlertTriangle size={18} aria-hidden="true" style={{ color: 'var(--danger)' }} />,
  warn: <TrendingUp size={18} aria-hidden="true" style={{ color: 'var(--warn)' }} />,
  ok: <CircleCheck size={18} aria-hidden="true" style={{ color: 'var(--ok)' }} />,
  info: <Info size={18} aria-hidden="true" style={{ color: 'var(--ink-2)' }} />,
};

function compare(current: number, previous: number | undefined, label: string | undefined): string | undefined {
  if (previous === undefined || !label) return undefined;
  const change = percentChange(current, previous);
  if (change === null) return undefined;
  return change === 0 ? `igual a ${label}` : `${change > 0 ? '+' : ''}${change}% vs ${label}`;
}

export function MoneyPage() {
  const { today } = useApp();
  const toast = useToast();
  const entries = useMoneyEntries();
  const budgets = useBudgets();
  const [view, setView] = useUiPref<MoneyView>('money.view', 'month');
  const [anchor, setAnchor] = useState(today);
  const [editing, setEditing] = useState<{ kind: MoneyKind; entry?: MoneyEntry } | null>(null);
  const [budgetsOpen, setBudgetsOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | MoneyKind>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [shown, setShown] = useState(60);

  const data = useMemo(() => {
    if (!entries || !budgets) return null;
    const period = moneyPeriod(view, anchor);
    const current = inPeriod(entries, period.start, period.end);
    const previous = period.prev ? inPeriod(entries, period.prev.start, period.prev.end) : [];
    const totals = moneyTotals(current);
    const prevTotals = period.prev ? moneyTotals(previous) : undefined;
    const monthPeriod = moneyPeriod('month', view === 'month' ? anchor : today);
    const monthEntries = inPeriod(entries, monthPeriod.start, monthPeriod.end);
    const statuses = view === 'month' ? budgetStatus(current, budgets) : [];
    const series = view === 'month' ? dailySeries(current, period.start, period.end) : view === 'year' ? monthlySeries(current, parseCivil(period.start).y) : yearlySeries(entries);
    // Dias (ou meses) já corridos no período — contando só desde o primeiro lançamento —, para as médias.
    const isCurrent = today >= period.start && today <= period.end;
    const lastDay = isCurrent ? today : period.end;
    const firstEntry = entries[0]?.date;
    const from = firstEntry && firstEntry > period.start ? firstEntry : period.start;
    const days = view === 'month' ? Math.max(1, diffDays(lastDay, from) + 1) : 0;
    const months = view === 'year' ? Math.max(1, parseCivil(lastDay).m - parseCivil(from > lastDay ? lastDay : from).m + 1) : 0;
    return {
      period,
      current,
      totals,
      prevTotals,
      monthPeriod,
      monthEntries,
      cats: byCategory(current, 'expense'),
      incomeCats: byCategory(current, 'income'),
      statuses,
      series,
      isCurrent,
      days,
      months,
      projection: monthProjection(totals.expense, today, period, firstEntry),
      insights: moneyInsights({ period, current, previous, budgets, today, firstEntry }),
      biggest: current.filter((e) => e.kind === 'expense').sort((a, b) => b.amountCents - a.amountCents || (a.date < b.date ? 1 : -1)).slice(0, 5),
    };
  }, [entries, budgets, view, anchor, today]);

  if (!entries || !budgets || !data) return <LoadingState />;
  const { period, totals, prevTotals } = data;
  const open = (kind: MoneyKind, entry?: MoneyEntry) => setEditing({ kind, entry });

  async function exportCsv() {
    const list = view === 'years' ? entries ?? [] : data?.current ?? [];
    const name = view === 'years' ? 'rotinas-dinheiro-todos.csv' : `rotinas-dinheiro-${period.start.slice(0, view === 'month' ? 7 : 4)}.csv`;
    const result = await downloadText(name, moneyCsv(list), 'text/csv');
    const problem = downloadProblem(result);
    toast.show(problem ?? 'Planilha exportada (abre no Excel e no Google Planilhas).', problem ? { tone: 'danger' } : undefined);
  }

  const header = (
    <PageHeader
      title="Dinheiro"
      subtitle="Seus gastos e entradas, com relatórios por mês, por ano e ano a ano. Fica só nos seus dados — nunca vai ao Kai."
      actions={
        <>
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => open('expense')}>
            Novo gasto
          </Button>
          <Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => open('income')}>
            Nova entrada
          </Button>
        </>
      }
    />
  );

  const dialogs = (
    <>
      {editing && <MoneyEntryDialog key={editing.entry?.id ?? editing.kind} initialKind={editing.kind} entry={editing.entry} entries={entries} onClose={() => setEditing(null)} />}
      {budgetsOpen && <BudgetsDialog entries={entries} monthEntries={data.monthEntries} monthLabel={data.monthPeriod.label} budgets={budgets} onClose={() => setBudgetsOpen(false)} />}
    </>
  );

  if (entries.length === 0) {
    return (
      <div className="page">
        {header}
        <EmptyState
          icon={<Wallet size={20} />}
          title="Registre seu primeiro gasto"
          action={
            <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => open('expense')}>
              Novo gasto
            </Button>
          }
        >
          <p>
            Anote cada gasto e cada entrada (mesada, vendas, trabalho) assim que acontecer — leva poucos segundos. Com os registros, esta tela mostra para onde vai o seu dinheiro, o que mais cresceu, os
            gastos pequenos que somam muito e gráficos por mês e por ano.
          </p>
        </EmptyState>
        {dialogs}
      </div>
    );
  }

  // ── Para onde vai o dinheiro ────────────────────────────────────────────
  const statusByKey = new Map(data.statuses.map((s) => [s.key, s]));
  const catRows = [...data.cats.slice(0, 12)];
  for (const s of data.statuses) if (!catRows.some((c) => c.key === s.key)) catRows.push({ key: s.key, category: s.category, cents: 0, count: 0, share: 0 });
  const scale = Math.max(1, ...catRows.map((c) => c.cents), ...data.statuses.map((s) => s.limit));
  const meterRows: MeterRow[] = catRows.map((c) => {
    const st = statusByKey.get(c.key);
    return {
      id: c.key,
      label: (
        <>
          {c.category}
          {st?.over && (
            <>
              {' '}
              <Tag tone="danger">acima do limite</Tag>
            </>
          )}
        </>
      ),
      value: c.cents,
      max: scale,
      valueLabel: `${formatMoney(c.cents)} · ${Math.round(c.share * 100)}%${st ? ` · limite ${formatMoney(st.limit)}` : ''}`,
      marker: st?.limit,
      markerLabel: st ? `Limite mensal: ${formatMoney(st.limit)}` : undefined,
      tone: st?.over ? 'danger' : undefined,
    };
  });

  // ── Evolução ────────────────────────────────────────────────────────────
  const evoTitle = view === 'month' ? 'Gastos por dia' : view === 'year' ? 'Mês a mês' : 'Ano a ano';
  const evoSeries =
    view === 'month'
      ? [{ name: 'Gastos', color: EXPENSE_COLOR, values: data.series.map((p) => p.expense) }]
      : [
          { name: 'Entradas', color: INCOME_COLOR, values: data.series.map((p) => p.income) },
          { name: 'Gastos', color: EXPENSE_COLOR, values: data.series.map((p) => p.expense) },
        ];
  const peak = data.series.reduce<(typeof data.series)[number] | null>((best, p) => (p.expense > (best?.expense ?? 0) ? p : best), null);
  const unit = view === 'month' ? 'Dia' : view === 'year' ? 'Mês' : 'Ano';
  const evoSummary = peak ? `${unit} com mais gastos: ${peak.fullLabel} (${formatMoney(peak.expense)}).` : 'Nenhum gasto no período.';

  // ── Lançamentos ─────────────────────────────────────────────────────────
  const listSource = view === 'years' ? entries : data.current;
  const listCategories = [...new Map(listSource.map((e) => [categoryKey(e.category), e.category])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  const filtered = listSource
    .filter((e) => (kindFilter === 'all' || e.kind === kindFilter) && (!categoryFilter || categoryKey(e.category) === categoryFilter))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.localeCompare(a.createdAt)));
  const visible = filtered.slice(0, shown);
  const groups: Array<{ date: string; items: MoneyEntry[] }> = [];
  for (const e of visible) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.date) last.items.push(e);
    else groups.push({ date: e.date, items: [e] });
  }

  const fourth =
    view === 'month' ? (
      <Stat
        label="Média de gastos por dia"
        value={formatMoney(Math.round(totals.expense / Math.max(1, data.days)))}
        note={data.projection !== null ? `Projeção do mês: ${formatMoney(data.projection)}` : `Em ${plural(data.days, 'dia', 'dias')} com registro`}
      />
    ) : view === 'year' ? (
      <Stat label="Média de gastos por mês" value={formatMoney(Math.round(totals.expense / Math.max(1, data.months)))} note={`Em ${plural(data.months, 'mês', 'meses')} com registro`} />
    ) : (
      <Stat label="Lançamentos" value={String(totals.count)} note={plural(data.series.length, 'ano', 'anos')} />
    );

  return (
    <div className="page">
      {header}

      <div className="money-period">
        <Segmented
          label="Visão"
          hideLabel
          value={view}
          onChange={(v) => {
            setView(v);
            setShown(60);
          }}
          options={[
            { value: 'month', label: 'Mês' },
            { value: 'year', label: 'Ano' },
            { value: 'years', label: 'Ano a ano' },
          ]}
        />
        {view !== 'years' && (
          <div className="money-period-nav">
            <IconButton label={view === 'month' ? 'Mês anterior' : 'Ano anterior'} onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}>
              <ChevronLeft size={20} aria-hidden="true" />
            </IconButton>
            <strong aria-live="polite">{capitalize(period.label)}</strong>
            <IconButton label={view === 'month' ? 'Próximo mês' : 'Próximo ano'} onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}>
              <ChevronRight size={20} aria-hidden="true" />
            </IconButton>
            {!data.isCurrent && (
              <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
                {view === 'month' ? 'Este mês' : 'Este ano'}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="stats" style={{ marginBottom: 20 }}>
        <Stat label="Entradas" value={formatMoney(totals.income)} note={compare(totals.income, prevTotals?.income, period.prev?.label)} />
        <Stat label="Gastos" value={formatMoney(totals.expense)} note={compare(totals.expense, prevTotals?.expense, period.prev?.label)} />
        <Stat
          label="Saldo"
          value={formatMoney(totals.balance)}
          note={totals.income > 0 ? (totals.balance >= 0 ? `Sobrou ${Math.round((totals.balance / totals.income) * 100)}% do que entrou` : 'Gastou mais do que entrou') : undefined}
        />
        {fourth}
      </div>

      {totals.count === 0 ? (
        <EmptyState title={`Nada registrado em ${period.label}`}>
          <p>Escolha outro período ou registre um gasto ou uma entrada.</p>
        </EmptyState>
      ) : (
        <>
          {data.insights.length > 0 && (
            <Section title="O que chama atenção" id="money-insights" description="Calculado pelo app a partir dos seus lançamentos, sem IA.">
              <div className="panel">
                <ul className="money-insights">
                  {data.insights.map((i) => (
                    <li key={i.text}>
                      {INSIGHT_ICON[i.tone]}
                      <span className="small">{i.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Section>
          )}

          <Section
            title="Para onde vai o seu dinheiro"
            id="money-categories"
            action={
              <Button size="sm" icon={<Target size={16} aria-hidden="true" />} onClick={() => setBudgetsOpen(true)}>
                Limites mensais
              </Button>
            }
          >
            {meterRows.length === 0 ? (
              <p className="meta">Nenhum gasto em {period.label}.</p>
            ) : (
              <ChartFrame
                title="Gastos por categoria"
                subtitle={capitalize(period.label)}
                method={
                  <p>
                    Soma dos gastos de cada categoria no período, da maior para a menor; a porcentagem é a parte da categoria no total de gastos. Na visão do mês, a marca vertical é o limite mensal da
                    categoria e a barra fica vermelha quando ele é ultrapassado.
                  </p>
                }
                summary={data.cats
                  .slice(0, 3)
                  .map((c) => `${c.category}: ${formatMoney(c.cents)} (${Math.round(c.share * 100)}%)`)
                  .join(' · ')}
                table={{ columns: ['Categoria', 'Gastos', '% do total', 'Lançamentos'], rows: data.cats.map((c) => [c.category, formatMoney(c.cents), `${Math.round(c.share * 100)}%`, c.count]) }}
              >
                <MeterList rows={meterRows} ariaLabel={`Gastos por categoria em ${period.label}`} />
              </ChartFrame>
            )}
          </Section>

          <Section title={evoTitle} id="money-evolution">
            <ChartFrame
              title={view === 'month' ? 'Gastos por dia' : 'Entradas × gastos'}
              subtitle={view === 'years' ? 'Todos os anos com registros' : capitalize(period.label)}
              legend={evoSeries.length > 1 ? evoSeries.map((s) => ({ label: s.name, color: s.color })) : undefined}
              method={<p>Soma dos lançamentos de cada {unit.toLowerCase()}, sem estimativas. Os gráficos mensais e anuais crescem sozinhos conforme você registra.</p>}
              summary={evoSummary}
              table={{
                columns: [unit, 'Entradas', 'Gastos', 'Saldo'],
                rows: data.series.filter((p) => p.income > 0 || p.expense > 0).map((p) => [p.fullLabel, formatMoney(p.income), formatMoney(p.expense), formatMoney(p.income - p.expense)]),
              }}
            >
              <ColumnChart
                labels={data.series.map((p) => p.label)}
                fullLabels={data.series.map((p) => p.fullLabel)}
                series={evoSeries}
                ariaLabel={`${evoTitle}: ${evoSummary}`}
                tickFormat={formatMoneyCompact}
                valueFormat={formatMoney}
              />
            </ChartFrame>
          </Section>

          {data.incomeCats.length > 0 && (
            <Section title="De onde vem o dinheiro" id="money-income">
              <MeterList
                ariaLabel={`Entradas por categoria em ${period.label}`}
                rows={data.incomeCats.map((c) => ({ id: c.key, label: c.category, value: c.cents, max: data.incomeCats[0].cents, valueLabel: `${formatMoney(c.cents)} · ${Math.round(c.share * 100)}%` }))}
              />
            </Section>
          )}

          {data.biggest.length > 0 && (
            <Section title="Maiores gastos" id="money-biggest">
              <div>
                {data.biggest.map((e) => (
                  <EntryRow key={e.id} entry={e} showDate onOpen={() => open(e.kind, e)} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Section
        title="Lançamentos"
        id="money-entries"
        action={
          <Button size="sm" icon={<Download size={16} aria-hidden="true" />} disabled={listSource.length === 0} onClick={() => void exportCsv()}>
            Exportar planilha
          </Button>
        }
      >
        <div className="field-row" style={{ alignItems: 'flex-end' }}>
          <Segmented
            label="Mostrar"
            value={kindFilter}
            onChange={setKindFilter}
            options={[
              { value: 'all', label: 'Todos' },
              { value: 'expense', label: 'Gastos' },
              { value: 'income', label: 'Entradas' },
            ]}
          />
          <SelectField label="Categoria" value={categoryFilter} onChange={setCategoryFilter} options={[{ value: '', label: 'Todas' }, ...listCategories.map(([value, label]) => ({ value, label }))]} />
        </div>
        {visible.length === 0 ? (
          <p className="meta">Nenhum lançamento com esses filtros.</p>
        ) : (
          groups.map((g) => (
            <div key={g.date}>
              <h3 className="money-day">{capitalize(formatLongDate(g.date, view !== 'month'))}</h3>
              {g.items.map((e) => (
                <EntryRow key={e.id} entry={e} onOpen={() => open(e.kind, e)} />
              ))}
            </div>
          ))
        )}
        {filtered.length > shown && (
          <div style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => setShown(shown + 100)}>
              Mostrar mais ({filtered.length - shown})
            </Button>
          </div>
        )}
      </Section>

      {dialogs}
    </div>
  );
}

function EntryRow({ entry, onOpen, showDate }: { entry: MoneyEntry; onOpen: () => void; showDate?: boolean }) {
  const income = entry.kind === 'income';
  const details = [showDate ? formatLongDate(entry.date) : null, entry.method ? PAYMENT_LABEL[entry.method] : null, entry.necessity ? NECESSITY_LABEL[entry.necessity] : null].filter(Boolean).join(' · ');
  return (
    <button type="button" className="money-row" onClick={onOpen}>
      <span className="grow">
        <span className="row-title" style={{ display: 'block' }}>
          {entry.description ?? entry.category}
        </span>
        <span className="meta">
          {entry.description ? entry.category : income ? 'Entrada' : 'Gasto'}
          {details ? ` · ${details}` : ''}
        </span>
      </span>
      <span className={`money-amount${income ? ' is-income' : ''}`}>
        {income ? '+' : '−'}
        {formatMoney(entry.amountCents)}
      </span>
    </button>
  );
}

import { ChartColumn, ChevronLeft, ChevronRight, Compass, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApp } from '../../app/context';
import { ChartFrame, LineChart, MeterList, TrackColumnChart } from '../../components/charts';
import { Segmented, TextField } from '../../components/form';
import { ButtonLink, EmptyState, IconButton, LoadingState, Notice, PageHeader, Section, Stat } from '../../components/ui';
import { useCheckins, useProgressEvents } from '../../db/hooks';
import { isCivilDate, type CivilDate } from '../../domain/civil';
import { formatNumber, plural } from '../../domain/format';
import { computeGoalProgress, HORIZON_LABEL } from '../../domain/goals';
import {
  bucketsFor,
  categoryDistribution,
  checkinSeries,
  completionSeries,
  MIN_CHECKINS_FOR_TREND,
  PERIOD_LABEL,
  rateSeriesIsMeaningful,
  resolvePeriod,
  shiftPeriod,
  streakRows,
  totalsOf,
  type PeriodKind,
} from '../../domain/reports';
import { formatRate, groupCompletions } from '../../domain/stats';
import { useUiPref } from '../../lib/browser';
import { useGoalContext } from '../shared/data';

export function ReportsPage() {
  const { today, weekStartsOn, prefs } = useApp();
  const ctx = useGoalContext();
  const checkins = useCheckins();
  const events = useProgressEvents();
  const [kind, setKind] = useUiPref<PeriodKind>('reports.kind', 'week');
  const [anchor, setAnchor] = useState<CivilDate>(today);
  const [custom, setCustom] = useState<{ start: CivilDate; end: CivilDate }>(() => resolvePeriod('custom', today, weekStartsOn));

  const period = useMemo(() => resolvePeriod(kind, anchor, weekStartsOn, kind === 'custom' ? custom : undefined), [kind, anchor, weekStartsOn, custom]);

  const data = useMemo(() => {
    if (!ctx || !checkins || !events) return null;
    const byHabit = groupCompletions(ctx.habitCompletions);
    const buckets = bucketsFor(period, weekStartsOn);
    const points = completionSeries(ctx.habits, byHabit, buckets, today);
    const totals = totalsOf(points);
    const categories = categoryDistribution(ctx.habits, ctx.habitCompletions, period.start, period.end, today);
    const streaks = streakRows(ctx.habits, byHabit, today);
    const goals = ctx.goals
      .filter((g) => g.status !== 'archived' && g.periodStart <= period.end && g.periodEnd >= period.start)
      .map((g) => ({ goal: g, progress: computeGoalProgress(g, ctx) }));
    const measurableGoals = goals.filter((g) => g.progress.ratio !== null && g.progress.kind !== 'manual_completion');
    const periodCheckins = checkins.filter((c) => c.date >= period.start && c.date <= period.end);
    const checkinPoints = checkinSeries(periodCheckins, buckets);
    const xp = events.filter((e) => e.localDate >= period.start && e.localDate <= period.end).reduce((s, e) => s + e.xp, 0);
    return { buckets, points, totals, categories, streaks, goals, measurableGoals, periodCheckins, checkinPoints, xp };
  }, [ctx, checkins, events, period, weekStartsOn, today]);

  const periodLabel = period.label;

  return (
    <div className="page page-wide">
      <PageHeader title="Relatórios" subtitle="Tudo aqui é calculado a partir dos seus registros neste aparelho." />
      <div className="agenda-toolbar">
        <Segmented
          label="Período"
          hideLabel
          value={kind}
          onChange={(k) => {
            setKind(k);
            setAnchor(today);
          }}
          options={(['day', 'week', 'month', 'year', 'custom'] as PeriodKind[]).map((k) => ({ value: k, label: PERIOD_LABEL[k] }))}
        />
        {kind !== 'custom' && (
          <div className="row" style={{ gap: 0 }}>
            <IconButton label="Período anterior" onClick={() => setAnchor(shiftPeriod(period, -1, weekStartsOn).start)}>
              <ChevronLeft size={20} aria-hidden="true" />
            </IconButton>
            <IconButton label="Próximo período" onClick={() => setAnchor(shiftPeriod(period, 1, weekStartsOn).start)} disabled={period.end >= today}>
              <ChevronRight size={20} aria-hidden="true" />
            </IconButton>
          </div>
        )}
        <span className="agenda-range" aria-live="polite">
          {periodLabel}
        </span>
      </div>
      {kind === 'custom' && (
        <div className="field-row" style={{ maxWidth: 480, marginBottom: 16 }}>
          <TextField label="De" type="date" value={custom.start} max={custom.end} onChange={(v) => isCivilDate(v) && setCustom({ ...custom, start: v })} />
          <TextField label="Até" type="date" value={custom.end} min={custom.start} onChange={(v) => isCivilDate(v) && setCustom({ ...custom, end: v })} hint="Até 366 dias." />
        </div>
      )}

      {!data || !ctx ? (
        <LoadingState />
      ) : ctx.habits.length === 0 && ctx.goals.length === 0 ? (
        <EmptyState
          icon={<ChartColumn size={20} />}
          title="Os relatórios nascem dos seus registros"
          action={
            <ButtonLink to="/habitos/novo" variant="primary" icon={<Plus size={18} aria-hidden="true" />}>
              Criar um hábito
            </ButtonLink>
          }
        >
          <p>Crie hábitos ou metas e registre conclusões. A partir do primeiro registro, os gráficos mostram previstas × concluídas, taxa ao longo do tempo, sequências, categorias e metas — sempre com o período e o cálculo explicados.</p>
        </EmptyState>
      ) : (
        <>
          <div className="stats" style={{ marginBottom: 20 }}>
            <Stat label="Previstas encerradas" value={formatNumber(data.totals.done + data.totals.missed, 0)} note={data.totals.open > 0 ? `+${data.totals.open} em aberto hoje` : undefined} />
            <Stat label="Concluídas" value={formatNumber(data.totals.done, 0)} />
            <Stat label="Taxa de conclusão" value={formatRate(data.totals.rate)} note={data.totals.rate === null ? 'Sem ocorrências encerradas' : undefined} />
            <Stat label="Puladas" value={formatNumber(data.totals.skipped, 0)} note="Não entram na taxa" />
            <Stat label="XP no período" value={formatNumber(data.xp, 0)} />
          </div>

          {prefs.consents.kai.granted && data.totals.done + data.totals.missed > 0 && (
            <Notice
              tone="info"
              action={
                <Link to={`/kai?revisao=${period.start},${period.end}`} className="btn btn-secondary btn-sm">
                  <Compass size={16} aria-hidden="true" />
                  Pedir revisão ao Kai
                </Link>
              }
            >
              O Kai pode sugerir ajustes com base neste período, citando os registros usados. Sugestões são opcionais e nunca são previsões.
            </Notice>
          )}

          <Section title="Hábitos" id="rep-habits">
            {data.totals.scheduled === 0 ? (
              <EmptyState title="Sem ocorrências previstas neste período">
                <p>Escolha outro período ou confira se os hábitos já tinham começado (ou estavam pausados) nessas datas.</p>
              </EmptyState>
            ) : (
              <>
                <ChartFrame
                  title="Concluídas × previstas"
                  subtitle={`${periodLabel}. Unidade: ocorrências de hábitos.`}
                  legend={[
                    { label: 'Previstas', color: 'var(--chart-track)' },
                    { label: 'Concluídas', color: 'var(--chart-done)' },
                  ]}
                  summary={`No período, ${data.totals.done} de ${data.totals.done + data.totals.missed} ocorrências previstas já encerradas foram concluídas${data.totals.rate !== null ? ` (${formatRate(data.totals.rate)})` : ''}. ${data.totals.skipped > 0 ? `${plural(data.totals.skipped, 'foi pulada', 'foram puladas')}. ` : ''}Dias futuros não aparecem.`}
                  table={{
                    columns: ['Período', 'Previstas', 'Concluídas', 'Puladas', 'Perdidas'],
                    rows: data.points.filter((p) => !p.future).map((p) => [p.bucket.fullLabel, p.scheduled, p.done, p.skipped, p.missed]),
                  }}
                  method={
                    <>
                      <p>Para cada {period.kind === 'year' ? 'mês' : data.buckets.length > 62 ? 'semana' : 'dia'}, “previstas” conta as ocorrências agendadas de todos os hábitos (respeitando frequência, data de início e pausas), e “concluídas” conta as que você marcou.</p>
                      <p>Ocorrências puladas entram em “previstas” mas saem da taxa. Hoje só conta como perdido depois que o dia acaba.</p>
                    </>
                  }
                >
                  <TrackColumnChart
                    ariaLabel={`Gráfico de colunas: concluídas e previstas por ${period.kind === 'year' ? 'mês' : 'dia'}, ${periodLabel}.`}
                    columns={data.points.map((p) => ({
                      label: p.bucket.label,
                      fullLabel: p.bucket.fullLabel,
                      track: p.scheduled,
                      fill: p.done,
                      future: p.future,
                      tooltip: p.future ? 'Ainda não aconteceu' : `${p.done} concluídas de ${p.scheduled} previstas${p.skipped ? `, ${p.skipped} puladas` : ''}`,
                    }))}
                  />
                </ChartFrame>

                {period.kind !== 'day' &&
                  (rateSeriesIsMeaningful(data.points) ? (
                    <ChartFrame
                      title="Taxa de conclusão ao longo do tempo"
                      subtitle={`${periodLabel}. Unidade: % das ocorrências encerradas.`}
                      summary={`A linha mostra a taxa de cada ${period.kind === 'year' ? 'mês' : 'dia'} com ocorrências encerradas; ${period.kind === 'year' ? 'meses' : 'dias'} sem ocorrências ficam como lacuna, sem interpolação.`}
                      table={{ columns: ['Período', 'Taxa'], rows: data.points.filter((p) => p.rate !== null).map((p) => [p.bucket.fullLabel, formatRate(p.rate)]) }}
                      method={<p>Taxa = concluídas ÷ (concluídas + perdidas) dentro de cada intervalo. Puladas e a ocorrência de hoje ainda em aberto não entram.</p>}
                    >
                      <LineChart
                        ariaLabel={`Gráfico de linha da taxa de conclusão, ${periodLabel}.`}
                        labels={data.points.map((p) => p.bucket.label)}
                        fullLabels={data.points.map((p) => p.bucket.fullLabel)}
                        domain={[0, 100]}
                        tickFormat={(v) => `${Math.round(v)}%`}
                        series={[{ name: 'Taxa', color: 'var(--chart-done)', values: data.points.map((p) => (p.rate === null ? null : Math.round(p.rate * 100))), format: (v) => `${v}%` }]}
                      />
                    </ChartFrame>
                  ) : (
                    <div className="chart">
                      <p className="chart-title">Taxa de conclusão ao longo do tempo</p>
                      <p className="meta" style={{ marginTop: 4 }}>
                        Dados insuficientes: a linha aparece quando houver ao menos dois {period.kind === 'year' ? 'meses' : 'dias'} com ocorrências encerradas neste período.
                      </p>
                    </div>
                  ))}

                {data.categories.length > 0 && (
                  <ChartFrame
                    title="Distribuição por categoria"
                    subtitle={`${periodLabel}. Unidade: conclusões.`}
                    summary={data.categories.map((c) => `${c.category}: ${c.done} de ${c.scheduled} previstas`).join('; ') + '.'}
                    table={{ columns: ['Categoria', 'Concluídas', 'Previstas'], rows: data.categories.map((c) => [c.category, c.done, c.scheduled]) }}
                    method={<p>Soma das conclusões de cada categoria de hábito no período. A marca vertical indica o total previsto da categoria.</p>}
                  >
                    <MeterList
                      ariaLabel="Conclusões por categoria"
                      rows={data.categories.map((c) => ({
                        id: c.category,
                        label: c.category,
                        value: c.done,
                        max: Math.max(...data.categories.map((x) => x.scheduled), 1),
                        marker: c.scheduled,
                        markerLabel: `${c.scheduled} previstas`,
                        valueLabel: `${c.done} de ${c.scheduled}`,
                      }))}
                    />
                  </ChartFrame>
                )}
              </>
            )}

            {data.streaks.length > 0 && (
              <ChartFrame
                title="Sequências atuais"
                subtitle="Até hoje. Unidade: ocorrências seguidas."
                summary={data.streaks.slice(0, 5).map((s) => `${s.title}: ${s.current} (melhor: ${s.best})`).join('; ') + '.'}
                table={{ columns: ['Hábito', 'Atual', 'Melhor'], rows: data.streaks.map((s) => [s.title, s.current, s.best]) }}
                method={<p>Ocorrências previstas concluídas em seguida, até hoje. Dias sem ocorrência prevista e pausas não quebram; pular é neutro. A marca vertical mostra a melhor sequência do hábito.</p>}
              >
                <MeterList
                  ariaLabel="Sequência atual por hábito"
                  rows={data.streaks.map((s) => ({
                    id: s.habitId,
                    label: <Link to={`/habitos/${s.habitId}`}>{s.title}</Link>,
                    value: s.current,
                    max: Math.max(1, ...data.streaks.map((x) => x.best)),
                    marker: s.best,
                    markerLabel: `Melhor: ${s.best}`,
                    valueLabel: `${s.current} (melhor ${s.best})`,
                  }))}
                />
              </ChartFrame>
            )}
          </Section>

          <Section title="Metas" id="rep-goals">
            {data.goals.length === 0 ? (
              <p className="meta">Nenhuma meta com período neste intervalo.</p>
            ) : data.measurableGoals.length === 0 ? (
              <Notice tone="neutral">
                Há {plural(data.goals.length, 'meta', 'metas')} neste período, mas nenhuma com regra numérica de progresso (são de conclusão manual ou sem metas filhas). O progresso agregado só aparece quando há vínculo e regra de cálculo válidos.
              </Notice>
            ) : (
              <ChartFrame
                title="Progresso das metas"
                subtitle={`Metas que se cruzam com ${periodLabel.toLowerCase()}. Unidade: % do alvo.`}
                summary={data.measurableGoals.map(({ goal, progress }) => `${goal.title}: ${progress.current} de ${progress.target} ${progress.unit}${progress.manual ? ' (manual)' : ''}`).join('; ') + '.'}
                table={{
                  columns: ['Meta', 'Atual', 'Alvo', 'Regra'],
                  rows: data.measurableGoals.map(({ goal, progress }) => [goal.title, progress.current, progress.target ?? '—', progress.manual ? 'Manual' : progress.kind === 'child_goals' ? 'Metas filhas' : 'Itens vinculados']),
                }}
                method={<p>Cada meta usa a própria regra: itens vinculados (conclusões reais no período da meta), metas filhas concluídas, ou valor informado manualmente (marcado como manual). O progresso considera o período inteiro da meta, não só o filtro.</p>}
              >
                <MeterList
                  ariaLabel="Progresso das metas"
                  rows={data.measurableGoals.map(({ goal, progress }) => ({
                    id: goal.id,
                    label: (
                      <Link to={`/metas/${goal.id}`}>
                        {goal.title} <span className="meta">({HORIZON_LABEL[goal.horizon]}{progress.manual ? ', manual' : ''})</span>
                      </Link>
                    ),
                    value: progress.current,
                    max: progress.target ?? 1,
                    valueLabel: `${formatNumber(progress.current)} de ${formatNumber(progress.target ?? 0)} ${progress.unit}`,
                  }))}
                />
              </ChartFrame>
            )}
          </Section>

          {prefs.features.checkins && (
            <Section title="Check-ins" id="rep-checkins">
              {data.periodCheckins.length < MIN_CHECKINS_FOR_TREND || period.kind === 'day' ? (
                <p className="meta">
                  Dados insuficientes para tendência: {plural(data.periodCheckins.length, 'check-in', 'check-ins')} no período. A tendência aparece com {MIN_CHECKINS_FOR_TREND} ou mais, em períodos de uma semana ou mais.
                </p>
              ) : (
                <ChartFrame
                  title="Humor e energia"
                  subtitle={`${periodLabel}. Escala de 1 a 5 (média por ${period.kind === 'year' ? 'mês' : 'dia'}).`}
                  legend={[
                    { label: 'Humor', color: 'var(--chart-series-1)', shape: 'line' },
                    { label: 'Energia', color: 'var(--chart-series-2)', shape: 'line' },
                  ]}
                  summary={`${plural(data.periodCheckins.length, 'check-in', 'check-ins')} no período. A linha é descritiva: não indica causa nem relação com hábitos.`}
                  table={{
                    columns: ['Período', 'Humor', 'Energia', 'Registros'],
                    rows: data.checkinPoints.filter((p) => p.count > 0).map((p) => [p.bucket.fullLabel, p.mood === null ? '—' : p.mood.toFixed(1).replace('.', ','), p.energy === null ? '—' : p.energy.toFixed(1).replace('.', ','), p.count]),
                  }}
                  method={<p>Média simples das notas que você registrou em cada intervalo. Intervalos sem check-in ficam como lacuna. É um registro de bem-estar, não uma avaliação clínica.</p>}
                >
                  <LineChart
                    ariaLabel={`Gráfico de linhas de humor e energia, ${periodLabel}.`}
                    labels={data.checkinPoints.map((p) => p.bucket.label)}
                    fullLabels={data.checkinPoints.map((p) => p.bucket.fullLabel)}
                    domain={[1, 5]}
                    tickFormat={(v) => String(v)}
                    series={[
                      { name: 'Humor', color: 'var(--chart-series-1)', values: data.checkinPoints.map((p) => p.mood), format: (v) => v.toFixed(1).replace('.', ',') },
                      { name: 'Energia', color: 'var(--chart-series-2)', values: data.checkinPoints.map((p) => p.energy), format: (v) => v.toFixed(1).replace('.', ',') },
                    ]}
                  />
                </ChartFrame>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

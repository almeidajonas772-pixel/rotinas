import { CalendarPlus, ChevronLeft, ChevronRight, Ellipsis, Pencil, Plus, Trash } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApp } from '../../app/context';
import { ActionSheet, ConfirmDialog, Dialog } from '../../components/dialog';
import { SelectField, Segmented } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, IconButton, LoadingState, Notice, PageHeader, Section, Tag } from '../../components/ui';
import { useAgendaCompletions, useAgendaItems, useCompletions, useGoals, useHabits } from '../../db/hooks';
import { describeError } from '../../db/errors';
import { completeAgendaOccurrence, createAgendaItem, deleteAgendaItem, undoAgendaOccurrence, updateAgendaItem } from '../../db/repo-agenda';
import { recordHabit, undoHabitRecord } from '../../db/repo-habits';
import { describeRecurrence, expandAgenda, habitOccurrencesForAgenda, type AgendaOccurrence, type EditScope, type HabitAgendaOccurrence } from '../../domain/agenda';
import { addDays, addMonths, eachDay, endOfMonth, endOfWeek, isCivilDate, parseCivil, startOfMonth, startOfWeek, type CivilDate } from '../../domain/civil';
import { formatLongDate, formatMonthYear, formatRange, weekdayShort } from '../../domain/format';
import type { AgendaItem } from '../../domain/schemas';
import { groupCompletions } from '../../domain/stats';
import { useUiPref } from '../../lib/browser';
import { CheckButton } from '../today/TodayPage';
import { AgendaItemEditor } from './AgendaItemEditor';
import { editorDraftFromItem, emptyEditorDraft, toAgendaDraft, validateEditorDraft, type EditorDraft } from './editor-draft';

type View = 'day' | 'week' | 'month';
type KindFilter = 'habit' | 'task' | 'event';

interface Row {
  key: string;
  kind: KindFilter;
  title: string;
  date: CivilDate;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  done: boolean;
  skipped: boolean;
  occ?: AgendaOccurrence;
  habit?: HabitAgendaOccurrence;
  category?: string;
  goalId?: string;
}

const KIND_LABEL: Record<KindFilter, string> = { habit: 'Hábito', task: 'Tarefa', event: 'Evento' };

export function AgendaPage() {
  const { today, timezone, weekStartsOn } = useApp();
  const items = useAgendaItems();
  const agendaCompletions = useAgendaCompletions();
  const habits = useHabits();
  const completions = useCompletions();
  const goals = useGoals();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useUiPref<View>('agenda.view', 'week');
  const [date, setDate] = useState<CivilDate>(() => {
    const d = params.get('data');
    return d && isCivilDate(d) ? d : today;
  });
  const [kinds, setKinds] = useUiPref<KindFilter[]>('agenda.kinds', ['habit', 'task', 'event']);
  const [category, setCategory] = useState('');
  const [goalFilter, setGoalFilter] = useState('');
  // Abre o editor pré-preenchido quando vem de outro lugar (ex.: "Nova tarefa" numa meta ou passo do Kai).
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; item?: AgendaItem; originalDate?: CivilDate; draft: EditorDraft; errors: Record<string, string>; scope?: EditScope } | null>(() => {
    if (params.get('novo') !== '1') return null;
    const d = params.get('data');
    const base = d && isCivilDate(d) ? d : today;
    const kind = params.get('tipo');
    const draft = { ...emptyEditorDraft(base, kind === 'event' || kind === 'habit' ? kind : 'task'), title: (params.get('titulo') ?? '').slice(0, 120), goalId: params.get('meta') ?? '' };
    return { mode: 'create', draft, errors: {} };
  });
  const [scopeAsk, setScopeAsk] = useState<{ action: 'edit' | 'delete'; item: AgendaItem; originalDate: CivilDate } | null>(null);
  const [rowMenu, setRowMenu] = useState<Row | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ item: AgendaItem; originalDate?: CivilDate; scope: EditScope } | null>(null);
  const [saving, setSaving] = useState(false);

  // Limpa da URL os parâmetros de pré-preenchimento já usados (o editor abriu no estado inicial acima).
  useEffect(() => {
    if (params.get('novo') !== '1') return;
    const next = new URLSearchParams(params);
    ['novo', 'tipo', 'titulo', 'meta'].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const range = useMemo(() => {
    if (view === 'day') return { from: date, to: date };
    if (view === 'week') return { from: startOfWeek(date, weekStartsOn), to: endOfWeek(date, weekStartsOn) };
    return { from: startOfWeek(startOfMonth(date), weekStartsOn), to: endOfWeek(endOfMonth(date), weekStartsOn) };
  }, [view, date, weekStartsOn]);

  const data = useMemo(() => {
    if (!items || !agendaCompletions || !habits || !completions) return null;
    const occ = expandAgenda(items, range.from, range.to, timezone);
    const virtual = habitOccurrencesForAgenda(habits, range.from, range.to, occ);
    const byHabit = groupCompletions(completions);
    const doneItems = new Set(agendaCompletions.map((c) => c.id));
    const rows: Row[] = [
      ...occ.map((o) => {
        const habitStatus = o.kind === 'habit' && o.habitId ? byHabit.get(o.habitId)?.get(o.date) : undefined;
        return {
          key: o.key,
          kind: o.kind as KindFilter,
          title: o.title,
          date: o.date,
          allDay: o.allDay,
          startTime: o.startTime,
          endTime: o.endTime,
          done: o.kind === 'habit' ? habitStatus === 'done' : doneItems.has(o.key),
          skipped: habitStatus === 'skipped',
          occ: o,
          category: o.category ?? habits.find((h) => h.id === o.habitId)?.category,
          goalId: o.goalId,
        };
      }),
      ...virtual.map((v) => {
        const status = byHabit.get(v.habitId)?.get(v.date);
        return { key: v.key, kind: 'habit' as const, title: v.title, date: v.date, allDay: v.allDay, startTime: v.startTime, endTime: v.endTime, done: status === 'done', skipped: status === 'skipped', habit: v, category: v.category, goalId: v.goalId };
      }),
    ]
      .filter((r) => kinds.includes(r.kind))
      .filter((r) => (category ? r.category === category : true))
      .filter((r) => (goalFilter ? r.goalId === goalFilter : true))
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : (a.startTime ?? '99') < (b.startTime ?? '99') ? -1 : 1));
    const byDate = new Map<CivilDate, Row[]>();
    for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    const undated = items.filter((i) => i.seriesKind === 'undated' && i.status === 'active');
    // Tarefas sem data são concluídas com a data do dia em que foram marcadas.
    const undatedDone = new Map(agendaCompletions.filter((c) => undated.some((u) => u.id === c.itemId)).map((c) => [c.itemId, c]));
    const categories = [...new Set([...items.map((i) => i.category), ...habits.map((h) => h.category)].filter((c): c is string => Boolean(c)))].sort();
    return { rows, byDate, undated, undatedDone, doneItems, categories };
  }, [items, agendaCompletions, habits, completions, range, timezone, kinds, category, goalFilter]);

  function shift(direction: -1 | 1) {
    if (view === 'day') setDate(addDays(date, direction));
    else if (view === 'week') setDate(addDays(date, 7 * direction));
    else setDate(addMonths(date, direction));
  }

  async function toggle(row: Row) {
    try {
      if (row.habit) {
        if (row.date > today) {
          toast.show('Ocorrências futuras de hábitos não podem ser marcadas.', { tone: 'danger' });
          return;
        }
        if (row.done) await undoHabitRecord(row.habit.habitId, row.date);
        else await recordHabit(row.habit.habitId, row.date, 'done', { today, timezone });
      } else if (row.occ) {
        if (row.done) await undoAgendaOccurrence(row.occ.itemId, row.occ.originalDate, { displayDate: row.date });
        else await completeAgendaOccurrence(row.occ.itemId, row.occ.originalDate, { today, timezone, displayDate: row.date });
      }
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  function openEdit(row: Row, scope?: EditScope) {
    if (!row.occ || !items) return;
    const item = items.find((i) => i.id === row.occ!.itemId);
    if (!item) return;
    if (item.recurrence && !scope) {
      setScopeAsk({ action: 'edit', item, originalDate: row.occ.originalDate });
      return;
    }
    const occurrence = scope === 'this' ? { date: row.occ.date, title: row.occ.title, startTime: row.occ.startTime, endTime: row.occ.endTime } : scope === 'following' ? { date: row.occ.originalDate, title: item.title } : undefined;
    setEditor({ mode: 'edit', item, originalDate: row.occ.originalDate, draft: editorDraftFromItem(item, today, occurrence), errors: {}, scope });
  }

  function askDelete(row: Row) {
    if (!row.occ || !items) return;
    const item = items.find((i) => i.id === row.occ!.itemId);
    if (!item) return;
    if (item.recurrence) setScopeAsk({ action: 'delete', item, originalDate: row.occ.originalDate });
    else setConfirmDelete({ item, scope: 'all' });
  }

  async function saveEditor() {
    if (!editor || !habits) return;
    const errors = validateEditorDraft(editor.draft);
    if (Object.keys(errors).length > 0) {
      setEditor({ ...editor, errors });
      return;
    }
    setSaving(true);
    try {
      const draft = toAgendaDraft(editor.draft, habits);
      if (editor.mode === 'create') {
        await createAgendaItem(draft, { timezone });
        toast.show('Item criado na agenda.');
        if (draft.date) setDate(draft.date);
      } else if (editor.item) {
        await updateAgendaItem(editor.item.id, draft, { scope: editor.scope ?? 'all', originalDate: editor.originalDate, timezone });
        toast.show('Agenda atualizada.');
      }
      setEditor(null);
    } catch (e) {
      setEditor({ ...editor, errors: { ...editor.errors, _form: describeError(e) } });
    } finally {
      setSaving(false);
    }
  }

  async function postpone(row: Row) {
    if (!row.occ || !items) return;
    const item = items.find((i) => i.id === row.occ!.itemId);
    if (!item) return;
    const target = addDays(row.occ.date, 1);
    try {
      if (item.recurrence) {
        const d = { ...editorDraftFromItem(item, today, { date: target, title: row.occ.title, startTime: row.occ.startTime, endTime: row.occ.endTime }) };
        await updateAgendaItem(item.id, toAgendaDraft(d, habits ?? []), { scope: 'this', originalDate: row.occ.originalDate, timezone });
      } else {
        await updateAgendaItem(item.id, { ...toAgendaDraft(editorDraftFromItem(item, today), habits ?? []), date: target }, { scope: 'all', timezone });
      }
      toast.show(`Movido para ${formatLongDate(target)}.`);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  const rangeLabel = view === 'day' ? capitalize(formatLongDate(date, true)) : view === 'week' ? `Semana de ${formatRange(range.from, range.to)}` : capitalize(formatMonthYear(date));

  return (
    <div className="page page-wide">
      <PageHeader
        title="Agenda"
        subtitle="Hábitos previstos, tarefas, eventos e blocos de tempo. Funciona sem calendário externo."
        actions={
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditor({ mode: 'create', draft: emptyEditorDraft(view === 'day' || date >= today ? date : today), errors: {} })}>
            Novo item
          </Button>
        }
      />

      <div className="agenda-toolbar">
        <Segmented label="Visualização" hideLabel value={view} onChange={setView} options={[{ value: 'day', label: 'Dia' }, { value: 'week', label: 'Semana' }, { value: 'month', label: 'Mês' }]} />
        <div className="row" style={{ gap: 0 }}>
          <IconButton label="Anterior" onClick={() => shift(-1)}>
            <ChevronLeft size={20} aria-hidden="true" />
          </IconButton>
          <Button size="sm" variant="ghost" onClick={() => setDate(today)}>
            Hoje
          </Button>
          <IconButton label="Próximo" onClick={() => shift(1)}>
            <ChevronRight size={20} aria-hidden="true" />
          </IconButton>
        </div>
        <span className="agenda-range" aria-live="polite">
          {rangeLabel}
        </span>
      </div>

      <div className="row" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        <fieldset>
          <legend className="visually-hidden">Tipos visíveis</legend>
          <div className="chips">
            {(['habit', 'task', 'event'] as KindFilter[]).map((k) => (
              <button key={k} type="button" className="chip" aria-pressed={kinds.includes(k)} onClick={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}>
                <span className={`month-dot kind-${k}`} aria-hidden="true" />
                {k === 'habit' ? 'Hábitos' : k === 'task' ? 'Tarefas' : 'Eventos'}
              </button>
            ))}
          </div>
        </fieldset>
        {data && data.categories.length > 0 && (
          <div style={{ minWidth: 160 }}>
            <SelectField label="Categoria" value={category} onChange={setCategory} options={[{ value: '', label: 'Todas' }, ...data.categories.map((c) => ({ value: c, label: c }))]} />
          </div>
        )}
        {goals && goals.length > 0 && (
          <div style={{ minWidth: 180 }}>
            <SelectField label="Meta" value={goalFilter} onChange={setGoalFilter} options={[{ value: '', label: 'Todas' }, ...goals.filter((g) => g.status !== 'archived').map((g) => ({ value: g.id, label: g.title }))]} />
          </div>
        )}
      </div>

      {!data ? (
        <LoadingState />
      ) : (
        <>
          {view === 'week' && (
            <div className="week-strip" role="group" aria-label="Dias da semana">
              {eachDay(range.from, range.to).map((d) => {
                const count = (data.byDate.get(d) ?? []).length;
                return (
                  <button key={d} type="button" aria-pressed={d === date} className={d === today ? 'is-today' : ''} onClick={() => setDate(d)}>
                    <span>{weekdayShort(d)}</span>
                    <span className="wd-num">{parseCivil(d).d}</span>
                    <span>
                      {count || ''}
                      <span className="visually-hidden">{count === 0 ? ' nada agendado' : count === 1 ? ' item' : ' itens'}</span>
                    </span>
                    <span className="visually-hidden"> ({formatLongDate(d)})</span>
                  </button>
                );
              })}
            </div>
          )}

          {view === 'month' && (
            <MonthGrid from={range.from} to={range.to} month={date} today={today} selected={date} byDate={data.byDate} onSelect={setDate} />
          )}

          {view === 'week' ? (
            eachDay(range.from, range.to).map((d) => (
              <DayBlock key={d} date={d} today={today} rows={data.byDate.get(d) ?? []} onToggle={toggle} onMenu={setRowMenu} highlight={d === date} />
            ))
          ) : (
            <DayBlock date={date} today={today} rows={data.byDate.get(date) ?? []} onToggle={toggle} onMenu={setRowMenu} highlight />
          )}

          <Section title="Sem data" id="agenda-undated" description="Tarefas sem dia definido. Abra uma para agendar.">
            {data.undated.length === 0 ? (
              <p className="meta">Nenhuma tarefa sem data.</p>
            ) : (
              <ul className="list" role="list">
                {data.undated.map((t) => {
                  const done = data.undatedDone.get(t.id);
                  return (
                    <li key={t.id} className={`list-row${done ? ' is-done' : ''}`}>
                      <span className="kind-bar kind-task" aria-hidden="true" />
                      <CheckButton
                        pressed={Boolean(done)}
                        label={done ? `Desfazer conclusão de ${t.title}` : `Concluir ${t.title}`}
                        onClick={() =>
                          void (done ? undoAgendaOccurrence(t.id, done.occurrenceDate) : completeAgendaOccurrence(t.id, today, { today, timezone })).catch((e) =>
                            toast.show(describeError(e), { tone: 'danger' }),
                          )
                        }
                      />
                      <div className="row-main">
                        <span className="row-title">{t.title}</span>
                        <span className="row-meta">
                          {done ? <span>Concluída em {formatLongDate(done.occurrenceDate)}</span> : t.notes ? <span>{t.notes}</span> : <span>Sem data</span>}
                        </span>
                      </div>
                      <IconButton label={`Editar ${t.title}`} onClick={() => setEditor({ mode: 'edit', item: t, draft: editorDraftFromItem(t, today), errors: {}, scope: 'all' })}>
                        <Pencil size={18} aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Excluir ${t.title}`} onClick={() => setConfirmDelete({ item: t, scope: 'all' })}>
                        <Trash size={18} aria-hidden="true" />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </>
      )}

      <ActionSheet
        open={rowMenu !== null}
        onClose={() => setRowMenu(null)}
        title={rowMenu?.title ?? ''}
        description={rowMenu?.occ?.recurring ? describeRecurrence(items?.find((i) => i.id === rowMenu.occ?.itemId)?.recurrence) : rowMenu?.habit ? 'Ocorrência prevista pela frequência do hábito.' : undefined}
        actions={
          rowMenu
            ? [
                { label: rowMenu.done ? 'Desfazer conclusão' : 'Concluir', onSelect: () => void toggle(rowMenu) },
                { label: 'Editar ou mover', icon: <Pencil size={18} aria-hidden="true" />, hidden: !rowMenu.occ, onSelect: () => openEdit(rowMenu) },
                { label: 'Adiar para o dia seguinte', hidden: !rowMenu.occ || rowMenu.kind === 'habit', onSelect: () => void postpone(rowMenu) },
                {
                  label: 'Reservar um bloco de tempo para este hábito',
                  icon: <CalendarPlus size={18} aria-hidden="true" />,
                  hidden: !rowMenu.habit,
                  onSelect: () =>
                    setEditor({
                      mode: 'create',
                      draft: { ...emptyEditorDraft(rowMenu.date, 'habit'), habitId: rowMenu.habit!.habitId, title: rowMenu.title, allDay: false, startTime: rowMenu.startTime ?? '09:00', endTime: rowMenu.endTime ?? '' },
                      errors: {},
                    }),
                },
                { label: 'Abrir o hábito', hidden: !rowMenu.habit && rowMenu.kind !== 'habit', onSelect: () => navigate(`/habitos/${rowMenu.habit?.habitId ?? rowMenu.occ?.habitId}`) },
                { label: 'Excluir', icon: <Trash size={18} aria-hidden="true" />, danger: true, hidden: !rowMenu.occ, onSelect: () => askDelete(rowMenu) },
              ]
            : []
        }
      />

      <Dialog
        open={scopeAsk !== null}
        onClose={() => setScopeAsk(null)}
        title={scopeAsk?.action === 'edit' ? 'Editar item que se repete' : 'Excluir item que se repete'}
        description="Escolha o alcance da mudança."
      >
        <ul className="action-list">
          {(['this', 'following', 'all'] as EditScope[]).map((scope) => (
            <li key={scope}>
              <button
                type="button"
                onClick={() => {
                  const ask = scopeAsk!;
                  setScopeAsk(null);
                  if (ask.action === 'edit') {
                    const row = data?.rows.find((r) => r.occ?.itemId === ask.item.id && r.occ.originalDate === ask.originalDate);
                    if (row) openEdit(row, scope);
                    else {
                      const occurrence = scope === 'this' ? { date: ask.originalDate, title: ask.item.title } : scope === 'following' ? { date: ask.originalDate, title: ask.item.title } : undefined;
                      setEditor({ mode: 'edit', item: ask.item, originalDate: ask.originalDate, draft: editorDraftFromItem(ask.item, today, occurrence), errors: {}, scope });
                    }
                  } else setConfirmDelete({ item: ask.item, originalDate: ask.originalDate, scope });
                }}
              >
                {scope === 'this' ? 'Somente esta ocorrência' : scope === 'following' ? 'Esta e as próximas' : 'Todas as ocorrências'}
              </button>
            </li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === 'create' ? 'Novo item na agenda' : editor?.scope === 'this' ? 'Editar somente esta ocorrência' : editor?.scope === 'following' ? 'Editar esta e as próximas' : 'Editar item'}
        footer={
          <>
            <Button onClick={() => setEditor(null)}>Cancelar</Button>
            <Button variant="primary" busy={saving} onClick={() => void saveEditor()}>
              {editor?.mode === 'create' ? 'Criar' : 'Salvar'}
            </Button>
          </>
        }
      >
        {editor && habits && goals && (
          <div className="stack">
            {editor.errors._form && (
              <Notice tone="danger" role="alert">
                {editor.errors._form}
              </Notice>
            )}
            <AgendaItemEditor draft={editor.draft} onChange={(draft) => setEditor({ ...editor, draft })} errors={editor.errors} habits={habits} goals={goals} occurrenceOnly={editor.scope === 'this'} />
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Excluir da agenda?"
        danger
        confirmLabel="Excluir"
        message={
          <p className="small">
            {confirmDelete?.scope === 'this'
              ? 'Somente esta ocorrência será removida; as demais continuam.'
              : confirmDelete?.scope === 'following'
                ? 'Esta ocorrência e as próximas serão removidas; as anteriores continuam.'
                : `“${confirmDelete?.item.title}” será removido${confirmDelete?.item.recurrence ? ' com todas as ocorrências' : ''}, junto das conclusões registradas.`}
            {confirmDelete?.item.external && ' O evento já criado no Google Calendar não é apagado automaticamente.'}
          </p>
        }
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await deleteAgendaItem(confirmDelete.item.id, { scope: confirmDelete.scope, originalDate: confirmDelete.originalDate });
            toast.show('Removido da agenda.');
          } catch (e) {
            toast.show(describeError(e), { tone: 'danger' });
          }
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function DayBlock({ date, today, rows, onToggle, onMenu, highlight }: { date: CivilDate; today: CivilDate; rows: Row[]; onToggle: (r: Row) => void; onMenu: (r: Row) => void; highlight?: boolean }) {
  const isToday = date === today;
  return (
    <section className="agenda-day" aria-label={formatLongDate(date)} style={highlight ? undefined : { opacity: 1 }}>
      <div className={`agenda-day-head${isToday ? ' is-today' : ''}`}>
        <span className="day-num">{parseCivil(date).d}</span>
        <span className="small" style={{ fontWeight: 600 }}>
          {capitalize(formatLongDate(date).split(',')[0])}
        </span>
        {isToday && <Tag>Hoje</Tag>}
      </div>
      {rows.length === 0 ? (
        <p className="meta" style={{ paddingLeft: 2 }}>
          Nada agendado.
        </p>
      ) : (
        <ul className="list" role="list">
          {rows.map((r) => (
            <li key={r.key} className={`list-row${r.done ? ' is-done' : ''}`}>
              <span className={`kind-bar kind-${r.kind}`} aria-hidden="true" />
              <CheckButton pressed={r.done} skipped={r.skipped} label={r.done ? `Desfazer conclusão de ${r.title}` : `Concluir ${r.title}`} onClick={() => onToggle(r)} />
              <span className="row-time">{r.allDay ? (r.kind === 'habit' ? '—' : 'Dia') : r.startTime}</span>
              <div className="row-main">
                <span className="row-title">{r.title}</span>
                <span className="row-meta">
                  <span>{r.kind === 'habit' && r.occ ? 'Bloco de hábito' : KIND_LABEL[r.kind]}</span>
                  {r.endTime && <span>até {r.endTime}{r.occ?.endsNextDay ? ' (dia seguinte)' : ''}</span>}
                  {r.occ?.recurring && <span>Repete</span>}
                  {r.occ?.overridden && <span>Alterada</span>}
                  {r.occ?.shiftedZone && <span title={`Criado no fuso ${r.occ.shiftedZone}`}>Fuso convertido</span>}
                  {r.occ?.external && <span>Também no Google</span>}
                  {r.skipped && <Tag>Pulado</Tag>}
                </span>
              </div>
              <IconButton label={`Ações para ${r.title}`} onClick={() => onMenu(r)}>
                <Ellipsis size={20} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MonthGrid({ from, to, month, today, selected, byDate, onSelect }: { from: CivilDate; to: CivilDate; month: CivilDate; today: CivilDate; selected: CivilDate; byDate: Map<CivilDate, Row[]>; onSelect: (d: CivilDate) => void }) {
  const days = eachDay(from, to);
  const mStart = startOfMonth(month);
  const mEnd = endOfMonth(month);
  return (
    <div className="month-grid" role="group" aria-label={`Mês de ${formatMonthYear(month)}`} style={{ marginBottom: 20 }}>
      {days.slice(0, 7).map((d) => (
        <div key={`h-${d}`} className="month-head" aria-hidden="true">
          {weekdayShort(d)}
        </div>
      ))}
      {days.map((d) => {
        const rows = byDate.get(d) ?? [];
        const outside = d < mStart || d > mEnd;
        const kinds = [...new Set(rows.map((r) => r.kind))];
        return (
          <button
            key={d}
            type="button"
            className={`month-cell${outside ? ' is-outside' : ''}${d === today ? ' is-today' : ''}${d === selected ? ' is-selected' : ''}`}
            aria-pressed={d === selected}
            onClick={() => onSelect(d)}
          >
            <span className="month-day">{parseCivil(d).d}</span>
            {rows.length > 0 ? (
              <>
                <span className="month-dots" aria-hidden="true">
                  {kinds.map((k) => (
                    <span key={k} className={`month-dot kind-${k}`} />
                  ))}
                </span>
                <span className="month-count">
                  {rows.length}
                  <span className="visually-hidden">{rows.length === 1 ? ' item' : ' itens'}</span>
                </span>
              </>
            ) : (
              <span className="visually-hidden"> nada agendado</span>
            )}
            <span className="visually-hidden"> ({formatLongDate(d)})</span>
          </button>
        );
      })}
    </div>
  );
}

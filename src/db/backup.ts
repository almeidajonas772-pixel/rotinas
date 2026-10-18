import { z } from 'zod';
import { formatDate, formatInstant, formatLongDate } from '../domain/format';
import { computeGoalProgress, HORIZON_LABEL } from '../domain/goals';
import { describeRecurrence } from '../domain/agenda';
import { currentSchedule, describeSchedule, describeTiming } from '../domain/schedule';
import {
  agendaCompletionSchema,
  agendaItemSchema,
  checkinSchema,
  goalProgressEntrySchema,
  goalSchema,
  habitCompletionSchema,
  habitSchema,
  journalEntrySchema,
  kaiConversationSchema,
  kaiInsightSchema,
  preferencesSchema,
  profileSchema,
  progressEventSchema,
} from '../domain/schemas';
import { deriveProgressEvents, levelProgress, totalXp } from '../domain/xp';
import { db, nowIso, type RotinasDB } from './db';
import { DB_SCHEMA_VERSION, migrateTables } from './migrations';

/**
 * Backup local (exportação/importação manual). O arquivo JSON é a forma máquina-legível
 * completa; o Markdown é a forma legível. Integrações e o registro técnico de lembretes
 * não entram no backup (são específicos do aparelho/servidor), nem a senha opcional do
 * servidor privado.
 */

export const BACKUP_FORMAT = 'rotinas-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

const TABLE_SCHEMAS = {
  profile: profileSchema,
  prefs: preferencesSchema,
  habits: habitSchema,
  completions: habitCompletionSchema,
  agendaItems: agendaItemSchema,
  agendaCompletions: agendaCompletionSchema,
  checkins: checkinSchema,
  journal: journalEntrySchema,
  goals: goalSchema,
  goalProgress: goalProgressEntrySchema,
  progressEvents: progressEventSchema,
  kaiInsights: kaiInsightSchema,
  kaiConversations: kaiConversationSchema,
} as const;

export type BackupTableName = keyof typeof TABLE_SCHEMAS;
export const BACKUP_TABLES = Object.keys(TABLE_SCHEMAS) as BackupTableName[];

export type BackupTables = { [K in BackupTableName]: z.infer<(typeof TABLE_SCHEMAS)[K]>[] };

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  app: { name: 'Rotinas'; version: string };
  tables: BackupTables;
}

export const TABLE_LABEL: Record<BackupTableName, string> = {
  profile: 'Perfil',
  prefs: 'Preferências',
  habits: 'Hábitos',
  completions: 'Registros de hábitos',
  agendaItems: 'Itens da agenda',
  agendaCompletions: 'Conclusões da agenda',
  checkins: 'Check-ins',
  journal: 'Entradas do Diário',
  goals: 'Metas',
  goalProgress: 'Atualizações manuais de metas',
  progressEvents: 'Eventos de XP',
  kaiInsights: 'Análises do Kai',
  kaiConversations: 'Conversas com o Kai',
};

export async function exportBackup(database: RotinasDB = db): Promise<BackupFile> {
  return database.transaction('r', BACKUP_TABLES.map((t) => database.table(t)), async () => {
    const tables = {} as Record<BackupTableName, unknown[]>;
    for (const name of BACKUP_TABLES) tables[name] = await database.table(name).toArray();
    tables.prefs = (tables.prefs as BackupTables['prefs']).map((p) => ({ ...p, server: {} }));
    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      exportedAt: nowIso(),
      app: { name: 'Rotinas', version: import.meta.env?.VITE_APP_VERSION ?? '1.0.0' },
      tables: tables as BackupTables,
    };
  });
}

export function backupFileName(kind: 'json' | 'md', date: string): string {
  return `rotinas-backup-${date}.${kind}`;
}

export interface ParsedBackup {
  schemaVersion: number;
  exportedAt: string;
  tables: BackupTables;
  counts: Record<BackupTableName, number>;
  warnings: string[];
}

export type ParseBackupResult = { ok: true; backup: ParsedBackup } | { ok: false; errors: string[] };

/** Lê, migra e valida um backup. Nada é gravado aqui. */
export function parseBackup(text: string): ParseBackupResult {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, errors: ['Arquivo grande demais para um backup do Rotinas (limite de 50 MB).'] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['O arquivo não é um JSON válido.'] };
  }
  const header = z
    .object({
      format: z.literal(BACKUP_FORMAT),
      formatVersion: z.number().int(),
      schemaVersion: z.number().int().min(1),
      exportedAt: z.string(),
      tables: z.record(z.string(), z.array(z.unknown())),
    })
    .safeParse(raw);
  if (!header.success) return { ok: false, errors: ['Este arquivo não é um backup do Rotinas (cabeçalho ausente ou inválido).'] };
  const h = header.data;
  if (h.formatVersion > BACKUP_FORMAT_VERSION || h.schemaVersion > DB_SCHEMA_VERSION) {
    return { ok: false, errors: ['O backup foi feito por uma versão mais nova do Rotinas. Atualize o app antes de importar.'] };
  }
  const migrated = migrateTables(h.tables as Record<string, Record<string, unknown>[]>, h.schemaVersion);

  const errors: string[] = [];
  const warnings: string[] = [];
  const tables = {} as Record<BackupTableName, unknown[]>;
  for (const name of BACKUP_TABLES) {
    const rows = migrated[name] ?? [];
    const schema = TABLE_SCHEMAS[name] as z.ZodType<unknown>;
    const valid: unknown[] = [];
    rows.forEach((row, index) => {
      const r = schema.safeParse(row);
      if (r.success) valid.push(r.data);
      else if (errors.length < 20) errors.push(`${TABLE_LABEL[name]} #${index + 1}: ${r.error.issues[0]?.message ?? 'inválido'}`);
    });
    tables[name] = valid;
  }
  if (errors.length > 0) return { ok: false, errors };

  const t = tables as BackupTables;
  if (t.profile.length > 1 || t.prefs.length > 1) return { ok: false, errors: ['O backup contém mais de um perfil.'] };
  const journalDates = new Set<string>();
  for (const e of t.journal) {
    if (journalDates.has(e.date)) return { ok: false, errors: [`O Diário tem duas entradas para ${formatDate(e.date)}.`] };
    journalDates.add(e.date);
  }

  // Integridade referencial: registros órfãos são descartados com aviso.
  const habitIds = new Set(t.habits.map((x) => x.id));
  const itemIds = new Set(t.agendaItems.map((x) => x.id));
  const goalIds = new Set(t.goals.map((x) => x.id));
  const dropOrphans = <T>(list: T[], keep: (row: T) => boolean, label: string): T[] => {
    const kept = list.filter(keep);
    if (kept.length < list.length) warnings.push(`${list.length - kept.length} ${label} sem referência válida foram ignorados.`);
    return kept;
  };
  t.completions = dropOrphans(t.completions, (c) => habitIds.has(c.habitId), 'registros de hábito');
  t.agendaCompletions = dropOrphans(t.agendaCompletions, (c) => itemIds.has(c.itemId), 'conclusões da agenda');
  t.goalProgress = dropOrphans(t.goalProgress, (e) => goalIds.has(e.goalId), 'atualizações de meta');
  t.agendaItems = dropOrphans(t.agendaItems, (i) => i.kind !== 'habit' || (i.habitId !== undefined && habitIds.has(i.habitId)), 'blocos de hábito');
  for (const habit of t.habits) if (habit.goalId && !goalIds.has(habit.goalId)) delete habit.goalId;
  for (const item of t.agendaItems) if (item.goalId && !goalIds.has(item.goalId)) delete item.goalId;
  for (const goal of t.goals) if (goal.parentId && !goalIds.has(goal.parentId)) delete goal.parentId;

  const counts = Object.fromEntries(BACKUP_TABLES.map((n) => [n, (t[n] as unknown[]).length])) as Record<BackupTableName, number>;
  if (counts.profile === 0) warnings.push('O backup não tem perfil: depois de restaurar, o app pedirá a configuração inicial.');
  return { ok: true, backup: { schemaVersion: h.schemaVersion, exportedAt: h.exportedAt, tables: t, counts, warnings } };
}

/** Substitui TODOS os dados locais pelo conteúdo do backup (tudo ou nada). O XP é recalculado do histórico. */
export async function restoreBackup(backup: ParsedBackup, database: RotinasDB = db): Promise<void> {
  const allTables = [...BACKUP_TABLES.map((t) => database.table(t)), database.integrations, database.notificationLog];
  await database.transaction('rw', allTables, async () => {
    for (const table of allTables) await table.clear();
    for (const name of BACKUP_TABLES) {
      if (name === 'progressEvents') continue;
      const rows = backup.tables[name] as unknown[];
      if (rows.length > 0) await database.table(name).bulkAdd(rows);
    }
    const events = deriveProgressEvents({
      habitCompletions: backup.tables.completions,
      agendaCompletions: backup.tables.agendaCompletions,
      goals: backup.tables.goals,
    });
    if (events.length > 0) await database.progressEvents.bulkAdd(events);
  });
}

/** Apaga todos os dados locais do Rotinas neste navegador. */
export async function clearAllData(database: RotinasDB = db): Promise<void> {
  const tables = database.tables;
  await database.transaction('rw', tables, async () => {
    for (const table of tables) await table.clear();
  });
}

// ── Exportação legível (Markdown) ───────────────────────────────────────────

export async function exportReadable(database: RotinasDB = db): Promise<string> {
  const b = await exportBackup(database);
  const t = b.tables;
  const tz = t.profile[0]?.timezone ?? 'America/Sao_Paulo';
  const lines: string[] = [];
  const habitTitle = new Map(t.habits.map((h) => [h.id, h.title]));
  lines.push('# Rotinas — exportação legível', '');
  lines.push(`Gerado em ${formatInstant(b.exportedAt, tz)} (fuso ${tz}). Este arquivo contém seus dados pessoais, inclusive o Diário: guarde-o com cuidado.`, '');

  const p = t.profile[0];
  lines.push('## Perfil', '');
  if (p) {
    lines.push(`- Nome: ${p.name ?? '(não informado)'}`);
    lines.push(`- Fuso horário: ${p.timezone}`);
    lines.push(`- Objetivo principal: ${p.mainGoal ?? '(não informado)'}`);
    lines.push(`- Criado em: ${formatInstant(p.createdAt, tz)}`, '');
  } else lines.push('Sem perfil.', '');

  const xp = totalXp(deriveProgressEvents({ habitCompletions: t.completions, agendaCompletions: t.agendaCompletions, goals: t.goals }));
  const lvl = levelProgress(xp);
  lines.push('## Progresso', '', `- XP total: ${xp} (nível ${lvl.level})`, '');

  lines.push('## Hábitos', '');
  if (t.habits.length === 0) lines.push('Nenhum hábito.', '');
  for (const h of [...t.habits].sort((a, b) => a.order - b.order)) {
    const records = t.completions.filter((c) => c.habitId === h.id).sort((a, b) => (a.scheduledDate < b.scheduledDate ? -1 : 1));
    const done = records.filter((c) => c.status === 'done');
    lines.push(`### ${h.title}`, '');
    lines.push(`- Estado: ${h.status === 'active' ? 'ativo' : h.status === 'paused' ? 'pausado' : 'arquivado'}`);
    lines.push(`- Categoria: ${h.category}`);
    lines.push(`- Frequência atual: ${describeSchedule(currentSchedule(h))} (desde ${formatDate(h.scheduleHistory[h.scheduleHistory.length - 1].from)})`);
    lines.push(`- Horário: ${describeTiming(h.timing)}`);
    if (h.description) lines.push(`- Intenção: ${h.description}`);
    if (h.firstStep) lines.push(`- Primeiro passo: ${h.firstStep}`);
    lines.push(`- Conclusões registradas: ${done.length}; puladas: ${records.length - done.length}`);
    if (done.length > 0) lines.push(`- Datas concluídas: ${done.map((c) => formatDate(c.scheduledDate)).join(', ')}`);
    lines.push('');
  }

  lines.push('## Metas', '');
  if (t.goals.length === 0) lines.push('Nenhuma meta.', '');
  const ctx = {
    goals: t.goals,
    habits: t.habits,
    agendaItems: t.agendaItems,
    habitCompletions: t.completions,
    agendaCompletions: t.agendaCompletions,
    progressEntries: t.goalProgress,
  };
  for (const g of t.goals) {
    const pr = computeGoalProgress(g, ctx);
    lines.push(`### ${g.title} (${HORIZON_LABEL[g.horizon]})`, '');
    lines.push(`- Período: ${formatDate(g.periodStart)} a ${formatDate(g.periodEnd)}`);
    lines.push(`- Estado: ${g.status === 'active' ? 'ativa' : g.status === 'completed' ? 'concluída' : 'arquivada'}`);
    lines.push(`- Progresso: ${pr.target !== null ? `${pr.current} de ${pr.target} ${pr.unit}` : pr.explanation}`);
    lines.push(`- Como é calculado: ${pr.explanation}`);
    if (g.description) lines.push(`- Descrição: ${g.description}`);
    lines.push('');
  }

  lines.push('## Agenda', '');
  if (t.agendaItems.length === 0) lines.push('Nenhum item.', '');
  for (const i of [...t.agendaItems].sort((a, b) => ((a.date ?? '9999') < (b.date ?? '9999') ? -1 : 1))) {
    const kind = i.kind === 'task' ? 'Tarefa' : i.kind === 'event' ? 'Evento' : `Bloco de hábito (${habitTitle.get(i.habitId ?? '') ?? '?'})`;
    const when = i.date ? `${formatDate(i.date)}${i.allDay ? ' (dia inteiro)' : ` ${i.startTime ?? ''}${i.endTime ? `–${i.endTime}` : ''}`}` : 'sem data';
    lines.push(`- ${kind}: ${i.title} — ${when} — ${describeRecurrence(i.recurrence)}`);
  }
  lines.push('');

  lines.push('## Check-ins', '');
  if (t.checkins.length === 0) lines.push('Nenhum check-in.', '');
  for (const c of [...t.checkins].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    lines.push(`- ${formatDate(c.date)}: humor ${c.mood ?? '—'}/5, energia ${c.energy ?? '—'}/5${c.note ? ` — ${c.note}` : ''}`);
  }
  lines.push('');

  lines.push('## Diário', '');
  if (t.journal.length === 0) lines.push('Nenhuma entrada.', '');
  for (const e of [...t.journal].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    lines.push(`### ${formatLongDate(e.date, true)}`, '');
    if (e.text.trim()) lines.push(e.text.trim(), '');
    if (e.didToday) lines.push(`**O que eu fiz hoje?** ${e.didToday}`, '');
    if (e.whatWorked) lines.push(`**O que funcionou?** ${e.whatWorked}`, '');
    if (e.toImprove) lines.push(`**O que poderia melhorar?** ${e.toImprove}`, '');
    if (e.nextStep) lines.push(`**Qual é meu próximo passo?** ${e.nextStep}`, '');
  }

  lines.push('## Kai', '');
  lines.push(`- Conversas guardadas: ${t.kaiConversations.length}`);
  lines.push(`- Análises guardadas: ${t.kaiInsights.length}`, '');
  return lines.join('\n');
}

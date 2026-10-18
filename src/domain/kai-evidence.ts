import type { KaiContext } from '../../shared/kai';
import { KAI_THRESHOLDS } from '../../shared/kai';
import { formatShortDate, plural } from './format';
import { formatRate } from './stats';

/**
 * Evidências exibidas junto de cada insight. Os números NÃO vêm do texto do modelo:
 * o Kai só aponta referências (h1, g2, j1, checkins) e o app descreve cada uma a partir
 * do mesmo contexto que foi enviado — assim o que aparece como dado é sempre verificável.
 */

export interface EvidenceItem {
  ref: string;
  label: string;
  detail: string;
}

export function describeEvidence(ref: string, context: KaiContext): EvidenceItem | null {
  const period = context.period ? `${formatShortDate(context.period.start)} a ${formatShortDate(context.period.end)}` : 'período analisado';
  if (ref.startsWith('h')) {
    const habit = context.habits.find((h) => h.ref === ref);
    const agg = context.aggregates.find((a) => a.ref === ref);
    if (!habit || !agg) return null;
    const closed = agg.done + agg.missed;
    const base =
      closed > 0
        ? `${agg.done} de ${closed} ocorrências previstas já encerradas foram concluídas (${formatRate(agg.rate)}), de ${period}`
        : `Nenhuma ocorrência encerrada de ${period}`;
    const extras = [agg.skipped > 0 ? plural(agg.skipped, 'pulada', 'puladas') : '', agg.open > 0 ? 'hoje ainda em aberto' : '']
      .filter(Boolean)
      .join('; ');
    return { ref, label: habit.title, detail: extras ? `${base}; ${extras}.` : `${base}.` };
  }
  if (ref.startsWith('g')) {
    const goal = context.goals.find((g) => g.ref === ref);
    if (!goal) return null;
    const p = goal.progress;
    const value = p.target !== null ? `${formatNum(p.current)} de ${formatNum(p.target)} ${p.unit}` : `${formatNum(p.current)} ${p.unit}`;
    return {
      ref,
      label: goal.title,
      detail: `Meta de ${formatShortDate(goal.periodStart)} a ${formatShortDate(goal.periodEnd)}: ${value}${p.manual ? ' (atualização manual)' : ''}.`,
    };
  }
  if (ref.startsWith('j')) {
    const entry = context.journal?.find((j) => j.ref === ref);
    if (!entry) return null;
    return { ref, label: `Diário de ${formatShortDate(entry.date)}`, detail: 'Trecho compartilhado com o Kai com sua autorização.' };
  }
  if (ref === 'checkins') {
    if (!context.checkins) return null;
    return { ref, label: 'Check-ins', detail: `${plural(context.checkins.length, 'check-in registrado', 'check-ins registrados')} de ${period}.` };
  }
  if (ref === 'perfil') {
    return { ref, label: 'Sua configuração', detail: 'Objetivo principal e disponibilidade informados por você.' };
  }
  return null;
}

function formatNum(n: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(n);
}

export function resolveEvidence(refs: readonly string[], context: KaiContext): { items: EvidenceItem[]; invalid: string[] } {
  const items: EvidenceItem[] = [];
  const invalid: string[] = [];
  for (const ref of [...new Set(refs)]) {
    const item = describeEvidence(ref, context);
    if (item) items.push(item);
    else invalid.push(ref);
  }
  return { items, invalid };
}

/** Observações sobre um hábito só são exibidas se ele tem ocorrências encerradas suficientes. */
export function habitHasEnoughData(ref: string, context: KaiContext): boolean {
  const agg = context.aggregates.find((a) => a.ref === ref);
  if (!agg) return false;
  return agg.done + agg.missed >= KAI_THRESHOLDS.perHabitObservation.minClosedOccurrences;
}

export interface VerifiedObservation<T> {
  observation: T;
  evidence: EvidenceItem[];
}

/**
 * Filtra observações: só ficam as que citam ao menos uma evidência válida e, quando
 * citam hábitos, apenas hábitos com dados suficientes. Retorna também quantas foram descartadas.
 */
export function verifyObservations<T extends { evidenceRefs: string[] }>(observations: readonly T[], context: KaiContext): {
  kept: VerifiedObservation<T>[];
  discarded: number;
} {
  const kept: VerifiedObservation<T>[] = [];
  let discarded = 0;
  for (const obs of observations) {
    const habitRefs = obs.evidenceRefs.filter((r) => r.startsWith('h'));
    const enough = habitRefs.every((r) => habitHasEnoughData(r, context));
    const { items } = resolveEvidence(obs.evidenceRefs, context);
    if (items.length === 0 || !enough) {
      discarded += 1;
      continue;
    }
    kept.push({ observation: obs, evidence: items });
  }
  return { kept, discarded };
}

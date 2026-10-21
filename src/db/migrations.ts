import { CONSENT_TEXT_VERSION, DEFAULT_NIGHTLY } from './defaults';

/**
 * Migrações de dados entre versões do banco local. As mesmas funções são usadas
 * pelo upgrade do IndexedDB (Dexie) e pela importação de backups antigos, para que
 * um backup feito numa versão anterior seja restaurado no formato atual.
 *
 * Histórico:
 *  v1 — esquema inicial (perfil, preferências, hábitos, conclusões, agenda, metas, diário, check-ins, Kai, integrações).
 *  v2 — lembretes locais: tabela `notificationLog`, preferências de notificação e
 *       consentimento de notificações; campo `reminder` nos hábitos.
 *  v3 — sessão da noite: tabelas `dayPlans` (prioridade do dia) e `nightSessions` (conversas da noite),
 *       preferências `nightly` e as autorizações `kaiAgenda` e `voice` (começam desligadas).
 */

export const DB_SCHEMA_VERSION = 4;

type Loose = Record<string, unknown>;

export function upgradePrefsToV2(prefs: Loose): Loose {
  const out: Loose = { ...prefs };
  if (!out.notifications || typeof out.notifications !== 'object') {
    out.notifications = { channel: 'none', quietStart: '22:00', quietEnd: '07:00', allowedDays: [1, 2, 3, 4, 5, 6, 7], maxPerDay: 4 };
  }
  const consents = { ...((out.consents as Loose | undefined) ?? {}) };
  if (!consents.notifications) consents.notifications = { granted: false, version: CONSENT_TEXT_VERSION };
  out.consents = consents;
  return out;
}

export function upgradeHabitToV2(habit: Loose): Loose {
  if (habit.reminder && typeof habit.reminder === 'object') return habit;
  return { ...habit, reminder: { enabled: false } };
}

/** v3: autorizações novas desligadas e preferências da noite com os padrões. Autorizações existentes não mudam. */
export function upgradePrefsToV3(prefs: Loose): Loose {
  const out: Loose = { ...prefs };
  const consents = { ...((out.consents as Loose | undefined) ?? {}) };
  if (!consents.kaiAgenda) consents.kaiAgenda = { granted: false, version: 1 };
  if (!consents.voice) consents.voice = { granted: false, version: 1 };
  out.consents = consents;
  if (!out.nightly || typeof out.nightly !== 'object') {
    out.nightly = { ...DEFAULT_NIGHTLY, reminder: { ...DEFAULT_NIGHTLY.reminder } };
  }
  return out;
}

/** Aplica as migrações de dados a um backup exportado em `fromVersion`. */
export function migrateTables(tables: Record<string, Loose[]>, fromVersion: number): Record<string, Loose[]> {
  let current = { ...tables };
  if (fromVersion < 2) {
    current = {
      ...current,
      prefs: (current.prefs ?? []).map(upgradePrefsToV2),
      habits: (current.habits ?? []).map(upgradeHabitToV2),
      notificationLog: current.notificationLog ?? [],
    };
  }
  if (fromVersion < 3) {
    current = {
      ...current,
      prefs: (current.prefs ?? []).map(upgradePrefsToV3),
      dayPlans: current.dayPlans ?? [],
      nightSessions: current.nightSessions ?? [],
    };
  }
  if (fromVersion < 4) {
    current = { ...current, moneyEntries: current.moneyEntries ?? [], budgets: current.budgets ?? [] };
  }
  return current;
}

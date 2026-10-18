import { CONSENT_TEXT_VERSION } from './defaults';

/**
 * Migrações de dados entre versões do banco local. As mesmas funções são usadas
 * pelo upgrade do IndexedDB (Dexie) e pela importação de backups antigos, para que
 * um backup feito numa versão anterior seja restaurado no formato atual.
 *
 * Histórico:
 *  v1 — esquema inicial (perfil, preferências, hábitos, conclusões, agenda, metas, diário, check-ins, Kai, integrações).
 *  v2 — lembretes locais: tabela `notificationLog`, preferências de notificação e
 *       consentimento de notificações; campo `reminder` nos hábitos.
 */

export const DB_SCHEMA_VERSION = 2;

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
  return current;
}

import type { Consent, ConsentKey, Preferences, Profile } from '../domain/schemas';

/**
 * Versão do texto de cada autorização. Mudou o texto de uma autorização? Incremente a dela:
 * quem autorizou o texto anterior passa a ver o recurso desligado até revisar o texto novo.
 *
 * Histórico:
 *  1 — textos iniciais.
 *  kai 2 — inclui a sessão da noite (o que a pessoa fala ou escreve e a prioridade do dia).
 *  calendar 2 — inclui a leitura opcional de eventos (título, horário e cor).
 */
export const CONSENT_VERSIONS: Record<ConsentKey, number> = {
  kai: 2,
  kaiCheckins: 1,
  kaiJournal: 1,
  kaiAgenda: 1,
  calendar: 2,
  voice: 1,
  notifications: 1,
};

/** Mantido por compatibilidade com backups antigos: versão mínima de qualquer texto. */
export const CONSENT_TEXT_VERSION = 1;

export function deniedConsent(key: ConsentKey): Consent {
  return { granted: false, version: CONSENT_VERSIONS[key] };
}

export function decidedConsent(key: ConsentKey, granted: boolean, at: string): Consent {
  return { granted, updatedAt: at, version: CONSENT_VERSIONS[key] };
}

/** A autorização vale agora: foi concedida para o texto atual. */
export function consentActive(consent: Consent | undefined, key: ConsentKey): boolean {
  return Boolean(consent?.granted) && (consent?.version ?? 0) >= CONSENT_VERSIONS[key];
}

/**
 * Preferências como o app deve enxergá-las: autorizações concedidas para um texto antigo
 * ficam desligadas (com `outdated: true`) até a pessoa revisar. Nada é gravado aqui.
 */
export function effectivePrefs(prefs: Preferences): Preferences {
  let changed = false;
  const consents = { ...prefs.consents };
  for (const key of Object.keys(consents) as ConsentKey[]) {
    const c = consents[key];
    if (c?.granted && !consentActive(c, key)) {
      consents[key] = { ...c, granted: false, outdated: true };
      changed = true;
    }
  }
  return changed ? { ...prefs, consents } : prefs;
}

export const DEFAULT_NIGHTLY: Preferences['nightly'] = {
  reminder: { enabled: false, time: '21:30' },
  speak: true,
  rate: 1,
  handsFree: false,
};

/** Preferências de uma instalação nova: privacidade por padrão (tudo que sai do aparelho começa desligado). */
export function defaultPreferences(nowIso: string): Preferences {
  return {
    id: 'prefs',
    language: 'pt-BR',
    theme: 'system',
    weekStartsOn: 1,
    notifications: {
      channel: 'none',
      quietStart: '22:00',
      quietEnd: '07:00',
      allowedDays: [1, 2, 3, 4, 5, 6, 7],
      maxPerDay: 4,
    },
    features: { checkins: false },
    consents: {
      kai: deniedConsent('kai'),
      kaiCheckins: deniedConsent('kaiCheckins'),
      kaiJournal: deniedConsent('kaiJournal'),
      kaiAgenda: deniedConsent('kaiAgenda'),
      calendar: deniedConsent('calendar'),
      voice: deniedConsent('voice'),
      notifications: deniedConsent('notifications'),
    },
    server: {},
    nightly: { ...DEFAULT_NIGHTLY, reminder: { ...DEFAULT_NIGHTLY.reminder } },
    updatedAt: nowIso,
  };
}

export function newProfile(input: { timezone: string; now: string; name?: string }): Profile {
  return {
    id: 'me',
    name: input.name,
    timezone: input.timezone,
    availability: { periods: [], windows: [] },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export const HABIT_CATEGORIES = ['Saúde', 'Estudos', 'Trabalho', 'Mente', 'Casa', 'Finanças pessoais', 'Relações', 'Lazer', 'Outro'] as const;

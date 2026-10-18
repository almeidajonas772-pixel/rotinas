import type { Consent, Preferences, Profile } from '../domain/schemas';

/** Versão dos textos de consentimento. Mudou o texto? Incremente — consentimentos antigos deixam de valer. */
export const CONSENT_TEXT_VERSION = 1;

export function deniedConsent(): Consent {
  return { granted: false, version: CONSENT_TEXT_VERSION };
}

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
      kai: deniedConsent(),
      kaiCheckins: deniedConsent(),
      kaiJournal: deniedConsent(),
      calendar: deniedConsent(),
      notifications: deniedConsent(),
    },
    server: {},
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

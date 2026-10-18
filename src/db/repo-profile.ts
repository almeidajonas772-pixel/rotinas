import { preferencesSchema, profileSchema, type Availability, type ConsentKey, type Preferences, type Profile } from '../domain/schemas';
import { db, nowIso, type RotinasDB } from './db';
import { CONSENT_TEXT_VERSION, defaultPreferences, newProfile } from './defaults';
import { UserFacingError, validate } from './errors';
import { createHabitInTx, type HabitDraft } from './repo-habits';

export async function getProfile(database: RotinasDB = db): Promise<Profile | undefined> {
  return database.profile.get('me');
}

/** Preferências salvas ou, se ainda não existem, os padrões (privacidade por padrão). */
export async function getPrefs(database: RotinasDB = db): Promise<Preferences> {
  return (await database.prefs.get('prefs')) ?? defaultPreferences(nowIso());
}

export async function saveProfile(patch: Partial<Omit<Profile, 'id' | 'createdAt'>>, database: RotinasDB = db): Promise<Profile> {
  return database.transaction('rw', database.profile, async () => {
    const now = nowIso();
    const current = (await database.profile.get('me')) ?? newProfile({ timezone: patch.timezone ?? 'America/Sao_Paulo', now });
    const next = validate(profileSchema, { ...current, ...patch, id: 'me', updatedAt: now });
    await database.profile.put(next);
    return next;
  });
}

export async function updatePrefs(mutate: (current: Preferences) => Preferences, database: RotinasDB = db): Promise<Preferences> {
  return database.transaction('rw', database.prefs, async () => {
    const now = nowIso();
    const current = (await database.prefs.get('prefs')) ?? defaultPreferences(now);
    const next = validate(preferencesSchema, { ...mutate(structuredClone(current)), id: 'prefs', updatedAt: now });
    await database.prefs.put(next);
    return next;
  });
}

/**
 * Concede ou revoga um consentimento específico. Revogar o coaching por IA também revoga
 * os consentimentos dependentes (check-ins e Diário no Kai): para voltar a enviá-los,
 * a pessoa precisa autorizar cada um de novo.
 */
export async function setConsent(key: ConsentKey, granted: boolean, database: RotinasDB = db): Promise<Preferences> {
  return updatePrefs((prefs) => {
    const at = nowIso();
    const consents = { ...prefs.consents };
    consents[key] = { granted, updatedAt: at, version: CONSENT_TEXT_VERSION };
    if (key === 'kai' && !granted) {
      consents.kaiCheckins = { granted: false, updatedAt: at, version: CONSENT_TEXT_VERSION };
      consents.kaiJournal = { granted: false, updatedAt: at, version: CONSENT_TEXT_VERSION };
    }
    if ((key === 'kaiCheckins' || key === 'kaiJournal') && granted && !consents.kai.granted) {
      throw new UserFacingError('Ative o coaching por IA antes de autorizar dados adicionais.');
    }
    const notifications = key === 'notifications' && !granted ? { ...prefs.notifications, channel: 'none' as const } : prefs.notifications;
    return { ...prefs, consents, notifications };
  }, database);
}

export interface OnboardingInput {
  name?: string;
  timezone: string;
  mainGoal?: string;
  availability: Availability;
  weekStartsOn: 0 | 1;
  checkins: boolean;
  notifications: { wanted: boolean; quietStart: string; quietEnd: string };
  consents: { kai: boolean; kaiCheckins: boolean; kaiJournal: boolean };
  habits: HabitDraft[];
  today: string;
}

/** Salva perfil, preferências e a primeira rotina de uma vez (tudo ou nada). */
export async function completeOnboarding(input: OnboardingInput, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.profile, database.prefs, database.habits], async () => {
    const now = nowIso();
    const profile = validate(profileSchema, {
      id: 'me',
      name: input.name?.trim() || undefined,
      timezone: input.timezone,
      mainGoal: input.mainGoal?.trim() || undefined,
      availability: input.availability,
      createdAt: (await database.profile.get('me'))?.createdAt ?? now,
      updatedAt: now,
      onboardingCompletedAt: now,
    });
    const base = (await database.prefs.get('prefs')) ?? defaultPreferences(now);
    const consent = (granted: boolean) => ({ granted, updatedAt: now, version: CONSENT_TEXT_VERSION });
    const prefs = validate(preferencesSchema, {
      ...base,
      weekStartsOn: input.weekStartsOn,
      features: { checkins: input.checkins },
      notifications: {
        ...base.notifications,
        quietStart: input.notifications.quietStart,
        quietEnd: input.notifications.quietEnd,
        // O canal local só liga depois da permissão do navegador (em Configurações ou no fim do onboarding).
        channel: 'none',
      },
      consents: {
        ...base.consents,
        kai: consent(input.consents.kai),
        kaiCheckins: consent(input.consents.kai && input.checkins && input.consents.kaiCheckins),
        kaiJournal: consent(input.consents.kai && input.consents.kaiJournal),
        notifications: consent(input.notifications.wanted),
      },
      updatedAt: now,
    });
    await database.profile.put(profile);
    await database.prefs.put(prefs);
    let order = 0;
    for (const draft of input.habits) {
      await createHabitInTx(database, draft, { today: input.today }, order);
      order += 1;
    }
  });
}

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { todayInZone, type CivilDate } from '../domain/civil';
import type { Preferences, Profile } from '../domain/schemas';
import { msUntilNextMidnight } from '../domain/tz';

export interface AppContextValue {
  profile: Profile;
  prefs: Preferences;
  /** Data local de hoje no fuso do perfil (atualiza à meia-noite local). */
  today: CivilDate;
  timezone: string;
  weekStartsOn: 0 | 1;
}

const AppContext = createContext<AppContextValue | null>(null);

/** "Hoje" no fuso do perfil, recalculado na virada do dia e quando o app volta ao primeiro plano. */
function useTodayIn(timeZone: string): CivilDate {
  const [state, setState] = useState(() => ({ timeZone, today: todayInZone(timeZone) }));
  // Fuso mudou (ex.: edição do perfil): recalcula durante a renderização, sem efeito em cascata.
  if (state.timeZone !== timeZone) setState({ timeZone, today: todayInZone(timeZone) });
  useEffect(() => {
    const update = () => setState((s) => {
      const today = todayInZone(timeZone);
      return s.timeZone === timeZone && s.today === today ? s : { timeZone, today };
    });
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        update();
        schedule();
      }, msUntilNextMidnight(timeZone) + 500);
    };
    schedule();
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        update();
        schedule();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [timeZone]);
  return state.timeZone === timeZone ? state.today : todayInZone(timeZone);
}

export function AppProvider({ profile, prefs, children }: { profile: Profile; prefs: Preferences; children: ReactNode }) {
  const today = useTodayIn(profile.timezone);
  const value: AppContextValue = { profile, prefs, today, timezone: profile.timezone, weekStartsOn: prefs.weekStartsOn };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fora do AppProvider');
  return ctx;
}

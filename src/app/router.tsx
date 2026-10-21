import { createHashRouter } from 'react-router';
import { Shell } from './Shell';
import { TodayPage } from '../features/today/TodayPage';
import { HabitsPage } from '../features/habits/HabitsPage';
import { HabitFormPage } from '../features/habits/HabitFormPage';
import { HabitDetailPage } from '../features/habits/HabitDetailPage';
import { GoalsPage } from '../features/goals/GoalsPage';
import { GoalFormPage } from '../features/goals/GoalFormPage';
import { GoalDetailPage } from '../features/goals/GoalDetailPage';
import { AgendaPage } from '../features/agenda/AgendaPage';
import { MorePage } from '../features/more/MorePage';
import { NotFoundPage } from '../features/more/NotFoundPage';

/**
 * Rotas do espaço pessoal local (hash router: funciona em qualquer hospedagem estática e offline).
 * As telas do dia a dia carregam junto com o app; as demais chegam sob demanda (o service worker
 * guarda todas para uso sem internet).
 */
export const router = createHashRouter([
  {
    path: '/',
    element: <Shell />,
    HydrateFallback: () => (
      <p className="meta" role="status" style={{ padding: 24 }}>
        Carregando…
      </p>
    ),
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'noite', lazy: async () => ({ Component: (await import('../features/night/NightPage')).NightPage }) },
      { path: 'habitos', element: <HabitsPage /> },
      { path: 'habitos/novo', element: <HabitFormPage /> },
      { path: 'habitos/:id', element: <HabitDetailPage /> },
      { path: 'habitos/:id/editar', element: <HabitFormPage /> },
      { path: 'metas', element: <GoalsPage /> },
      { path: 'metas/nova', element: <GoalFormPage /> },
      { path: 'metas/:id', element: <GoalDetailPage /> },
      { path: 'metas/:id/editar', element: <GoalFormPage /> },
      { path: 'agenda', element: <AgendaPage /> },
      { path: 'dinheiro', lazy: async () => ({ Component: (await import('../features/money/MoneyPage')).MoneyPage }) },
      { path: 'relatorios', lazy: async () => ({ Component: (await import('../features/reports/ReportsPage')).ReportsPage }) },
      { path: 'diario', lazy: async () => ({ Component: (await import('../features/journal/JournalPage')).JournalPage }) },
      { path: 'kai', lazy: async () => ({ Component: (await import('../features/kai/KaiPage')).KaiPage }) },
      { path: 'calendario', lazy: async () => ({ Component: (await import('../features/calendar/CalendarPage')).CalendarPage }) },
      { path: 'conexoes', lazy: async () => ({ Component: (await import('../features/connect/ConnectPage')).ConnectPage }) },
      { path: 'configuracoes', lazy: async () => ({ Component: (await import('../features/settings/SettingsPage')).SettingsPage }) },
      { path: 'configuracoes/privacidade', lazy: async () => ({ Component: (await import('../features/settings/PrivacyPage')).PrivacyPage }) },
      { path: 'mais', element: <MorePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

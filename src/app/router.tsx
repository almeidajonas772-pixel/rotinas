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
import { ReportsPage } from '../features/reports/ReportsPage';
import { JournalPage } from '../features/journal/JournalPage';
import { KaiPage } from '../features/kai/KaiPage';
import { CalendarPage } from '../features/calendar/CalendarPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { PrivacyPage } from '../features/settings/PrivacyPage';
import { MorePage } from '../features/more/MorePage';
import { NightPage } from '../features/night/NightPage';
import { ConnectPage } from '../features/connect/ConnectPage';
import { NotFoundPage } from '../features/more/NotFoundPage';

/** Rotas do espaço pessoal local (hash router: funciona em qualquer hospedagem estática e offline). */
export const router = createHashRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'noite', element: <NightPage /> },
      { path: 'habitos', element: <HabitsPage /> },
      { path: 'habitos/novo', element: <HabitFormPage /> },
      { path: 'habitos/:id', element: <HabitDetailPage /> },
      { path: 'habitos/:id/editar', element: <HabitFormPage /> },
      { path: 'metas', element: <GoalsPage /> },
      { path: 'metas/nova', element: <GoalFormPage /> },
      { path: 'metas/:id', element: <GoalDetailPage /> },
      { path: 'metas/:id/editar', element: <GoalFormPage /> },
      { path: 'agenda', element: <AgendaPage /> },
      { path: 'relatorios', element: <ReportsPage /> },
      { path: 'diario', element: <JournalPage /> },
      { path: 'kai', element: <KaiPage /> },
      { path: 'calendario', element: <CalendarPage /> },
      { path: 'conexoes', element: <ConnectPage /> },
      { path: 'configuracoes', element: <SettingsPage /> },
      { path: 'configuracoes/privacidade', element: <PrivacyPage /> },
      { path: 'mais', element: <MorePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

import { CalendarClock, ChartColumn, ChevronRight, Compass, NotebookPen, Settings, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '../../components/ui';

const LINKS = [
  { to: '/diario', label: 'Diário', description: 'Reflexão diária privada', icon: NotebookPen },
  { to: '/relatorios', label: 'Relatórios', description: 'Gráficos dos seus registros', icon: ChartColumn },
  { to: '/kai', label: 'Kai', description: 'Assistente opcional de rotina', icon: Compass },
  { to: '/calendario', label: 'Calendário externo', description: 'Google Calendar e blocos de tempo', icon: CalendarClock },
  { to: '/configuracoes', label: 'Configurações', description: 'Perfil, notificações, backup e dados', icon: Settings },
  { to: '/configuracoes/privacidade', label: 'Privacidade', description: 'O que fica no aparelho e o que sai dele', icon: ShieldCheck },
];

export function MorePage() {
  return (
    <div className="page">
      <PageHeader title="Mais" />
      <ul className="list" role="list">
        {LINKS.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="list-row row-link">
              <l.icon size={22} aria-hidden="true" />
              <span className="row-main">
                <span className="row-title">{l.label}</span>
                <span className="row-meta">{l.description}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

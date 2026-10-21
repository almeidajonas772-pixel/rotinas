import { CalendarClock, ChartColumn, ChevronRight, Compass, Moon, NotebookPen, PlugZap, Settings, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '../../components/ui';
import { isClaudeRuntime } from '../../platform/runtime';

function links(claude: boolean) {
  return [
  { to: '/noite', label: 'Noite', description: claude ? 'Feche o dia e decida o amanhã com o Kai' : 'Feche o dia e decida o amanhã, por voz ou texto', icon: Moon },
  { to: '/diario', label: 'Diário', description: 'Reflexão diária privada', icon: NotebookPen },
  { to: '/relatorios', label: 'Relatórios', description: 'Gráficos dos seus registros', icon: ChartColumn },
  { to: '/kai', label: 'Kai', description: 'Assistente opcional de rotina', icon: Compass },
  { to: '/calendario', label: 'Calendário externo', description: claude ? 'Google Agenda, blocos de tempo e lembretes' : 'Google Calendar e blocos de tempo', icon: CalendarClock },
  { to: '/conexoes', label: 'Conectar Kai e Google', description: claude ? 'O que já funciona e o passo que falta' : 'Assistente passo a passo da publicação', icon: PlugZap },
  { to: '/configuracoes', label: 'Configurações', description: claude ? 'Perfil, lembretes, backup e dados' : 'Perfil, notificações, backup e dados', icon: Settings },
  { to: '/configuracoes/privacidade', label: 'Privacidade', description: claude ? 'Onde seus dados ficam e o que vai ao Kai e ao Google' : 'O que fica no aparelho e o que sai dele', icon: ShieldCheck },
  ];
}

export function MorePage() {
  return (
    <div className="page">
      <PageHeader title="Mais" />
      <ul className="list" role="list">
        {links(isClaudeRuntime()).map((l) => (
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

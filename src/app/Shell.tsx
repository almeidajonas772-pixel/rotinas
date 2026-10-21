import {
  CalendarClock,
  CalendarDays,
  ChartColumn,
  Compass,
  Ellipsis,
  Moon,
  NotebookPen,
  PlugZap,
  Repeat,
  Settings,
  Sun,
  Target,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Button } from '../components/ui';
import { useOnline } from '../lib/browser';
import { usePwa } from '../lib/pwa';
import { isClaudeRuntime } from '../platform/runtime';
import { useCloudSync } from '../platform/cloud-sync';
import { cloudSummary } from '../features/shared/cloud-summary';

const NAV = [
  { to: '/', label: 'Hoje', icon: Sun, end: true },
  { to: '/noite', label: 'Noite', icon: Moon },
  { to: '/agenda', label: 'Agenda', icon: CalendarDays },
  { to: '/habitos', label: 'Hábitos', icon: Repeat },
  { to: '/metas', label: 'Metas', icon: Target },
  { to: '/diario', label: 'Diário', icon: NotebookPen },
  { to: '/relatorios', label: 'Relatórios', icon: ChartColumn },
];

const NAV_SECONDARY = [
  { to: '/kai', label: 'Kai', icon: Compass },
  { to: '/calendario', label: 'Calendário externo', icon: CalendarClock },
  { to: '/conexoes', label: 'Conectar Kai e Google', icon: PlugZap },
  { to: '/configuracoes', label: 'Configurações', icon: Settings },
];

const TABS = [
  { to: '/', label: 'Hoje', icon: Sun, end: true },
  { to: '/agenda', label: 'Agenda', icon: CalendarDays },
  { to: '/habitos', label: 'Hábitos', icon: Repeat },
  { to: '/metas', label: 'Metas', icon: Target },
  { to: '/noite', label: 'Noite', icon: Moon },
  { to: '/mais', label: 'Mais', icon: Ellipsis },
];

const MORE_PATHS = ['/mais', '/diario', '/relatorios', '/kai', '/calendario', '/conexoes', '/configuracoes'];

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
      <path d="M12 2.75a9.25 9.25 0 0 1 9.25 9.25" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="12" y1="12" x2="12" y2="5.5" stroke="var(--now)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.8" fill="var(--now)" />
    </svg>
  );
}

export function Shell() {
  const online = useOnline();
  const sync = useCloudSync();
  const cloudFooter = cloudSummary(sync);
  const pwa = usePwa();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Ao trocar de tela: volta ao topo e move o foco para o conteúdo (leitores de tela anunciam a nova página).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  const moreActive = MORE_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`));

  return (
    <div className="shell">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Pular para o conteúdo
      </a>
      <nav className="sidenav" aria-label="Principal">
        <NavLink to="/" className="brand" aria-label="Rotinas — Hoje">
          <BrandMark />
          Rotinas
        </NavLink>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="navlink">
            <item.icon size={20} aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
        <p className="nav-group-label">Assistente e conexões</p>
        {NAV_SECONDARY.map((item) => (
          <NavLink key={item.to} to={item.to} className="navlink">
            <item.icon size={20} aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
        <p className="nav-footer">{cloudFooter}</p>
      </nav>
      <div className="shell-main">
        {!online && (
          <div className="banner" role="status">
            <WifiOff size={16} aria-hidden="true" />
            {isClaudeRuntime()
              ? 'Sem conexão. O que você registrar fica neste aparelho e vai para a sua conta do Claude quando a conexão voltar; Kai e Google Agenda também voltam.'
              : 'Sem conexão. Tudo continua funcionando e salvando neste aparelho; Kai e calendário externo voltam quando a conexão voltar.'}
          </div>
        )}
        {pwa.needRefresh && (
          <div className="banner is-info" role="status">
            <span className="grow">Uma nova versão do Rotinas está pronta.</span>
            <Button size="sm" variant="primary" onClick={pwa.update}>
              Atualizar agora
            </Button>
            <Button size="sm" variant="ghost" onClick={pwa.dismiss}>
              Depois
            </Button>
          </div>
        )}
        {pwa.offlineReady && !pwa.needRefresh && (
          <div className="banner" role="status">
            <span className="grow">Pronto para funcionar sem internet neste aparelho.</span>
            <Button size="sm" variant="ghost" onClick={pwa.dismiss}>
              Ok
            </Button>
          </div>
        )}
        <main id="main" ref={mainRef} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <nav className="tabbar" aria-label="Principal (atalhos)">
        {TABS.map((item) =>
          item.to === '/mais' ? (
            <Link key={item.to} to={item.to} className="tablink" aria-current={moreActive ? 'page' : undefined}>
              <item.icon size={22} aria-hidden="true" />
              {item.label}
            </Link>
          ) : (
            <NavLink key={item.to} to={item.to} end={item.end} className="tablink">
              <item.icon size={22} aria-hidden="true" />
              {item.label}
            </NavLink>
          ),
        )}
      </nav>
    </div>
  );
}

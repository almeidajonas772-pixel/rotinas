/**
 * Mostrador de 24 horas do dia: meia-noite no topo, meio-dia embaixo.
 * Itens com horário aparecem no anel (preenchidos quando concluídos); janelas viram arcos;
 * o ponteiro âmbar marca "agora". É um resumo visual — a lista abaixo é a interface principal.
 */

export interface DialItem {
  id: string;
  label: string;
  kind: 'habit' | 'task' | 'event';
  start: number;
  end?: number;
  done: boolean;
}

const C = 120;
const R_ITEMS = 86;
const R_TICKS_OUT = 104;

function polar(minutes: number, r: number): [number, number] {
  const angle = (minutes / 1440) * Math.PI * 2 - Math.PI / 2;
  return [C + r * Math.cos(angle), C + r * Math.sin(angle)];
}

function arcPath(startMin: number, endMin: number, r: number): string {
  const [x1, y1] = polar(startMin, r);
  const [x2, y2] = polar(endMin, r);
  const large = endMin - startMin > 720 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function DayDial({ nowMinutes, nowLabel, items, summary }: { nowMinutes: number; nowLabel: string; items: DialItem[]; summary: string }) {
  const [hx0, hy0] = polar(nowMinutes, 52);
  const [hx, hy] = polar(nowMinutes, 76);
  return (
    <svg className="dial" viewBox="0 0 240 240" role="img" aria-label={summary}>
      <circle className="dial-face" cx={C} cy={C} r={112} />
      {Array.from({ length: 24 }, (_, h) => {
        const major = h % 6 === 0;
        const [x1, y1] = polar(h * 60, R_TICKS_OUT);
        const [x2, y2] = polar(h * 60, major ? R_TICKS_OUT - 9 : R_TICKS_OUT - 5);
        return <line key={h} className={`dial-tick${major ? ' major' : ''}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
      {[0, 6, 12, 18].map((h) => {
        const [x, y] = polar(h * 60, R_TICKS_OUT - 19);
        return (
          <text key={h} className="dial-hour" x={x} y={y} textAnchor="middle" dominantBaseline="central">
            {String(h).padStart(2, '0')}
          </text>
        );
      })}
      {items
        .filter((i) => i.end !== undefined && i.end > i.start)
        .map((i) => (
          <path key={`w-${i.id}`} className={`dial-window${i.done ? ' is-done' : ''}`} d={arcPath(i.start, i.end!, R_ITEMS)} />
        ))}
      {items.map((i) => {
        const [x, y] = polar(i.start, R_ITEMS);
        return <circle key={i.id} className={`dial-item${i.done ? ' is-done' : ''}${i.kind !== 'habit' ? ' is-task' : ''}`} cx={x} cy={y} r={6} />;
      })}
      <line className="dial-hand" x1={hx0} y1={hy0} x2={hx} y2={hy} />
      <circle className="dial-hand-dot" cx={hx} cy={hy} r={3.5} />
      <text className="dial-now" x={C} y={C + 4} textAnchor="middle">
        {nowLabel}
      </text>
      <text className="dial-caption" x={C} y={C + 20} textAnchor="middle">
        agora
      </text>
    </svg>
  );
}

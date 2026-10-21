import { Table2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Explain } from './ui';

/**
 * Gráficos em SVG, sem bibliotecas externas. Regras (skill de dataviz):
 * marcas finas (colunas ≤ 24 px com ponta arredondada de 4 px, linhas de 2 px, marcadores ≥ 8 px),
 * grade recessiva, legenda para 2+ séries, texto sempre nas cores de texto, tooltip ao passar o mouse,
 * tabela alternativa e explicação do cálculo em todos os gráficos.
 */

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(260, Math.floor(el.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'square' | 'line';
}

export function ChartFrame({
  title,
  subtitle,
  legend,
  method,
  summary,
  table,
  children,
}: {
  title: string;
  subtitle: string;
  legend?: LegendItem[];
  method: ReactNode;
  summary: ReactNode;
  table?: { columns: string[]; rows: Array<Array<string | number>> };
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  return (
    <figure className="chart">
      <div className="chart-head">
        <div>
          <figcaption className="chart-title">{title}</figcaption>
          <p className="chart-sub">{subtitle}</p>
        </div>
        {table && (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable(!showTable)}>
            <Table2 size={16} aria-hidden="true" />
            {showTable ? 'Ocultar tabela' : 'Ver tabela'}
          </button>
        )}
      </div>
      {legend && legend.length > 1 && (
        <div className="legend" style={{ marginBottom: 8 }}>
          {legend.map((l) => (
            <span key={l.label} className="legend-item">
              {l.shape === 'line' ? (
                <span aria-hidden="true" style={{ width: 16, height: 2, background: l.color, borderRadius: 1, display: 'inline-block' }} />
              ) : (
                <span className="swatch" style={{ background: l.color }} aria-hidden="true" />
              )}
              {l.label}
            </span>
          ))}
        </div>
      )}
      {children}
      <p className="chart-summary">{summary}</p>
      {table && showTable && (
        <div className="table-wrap" id={tableId}>
          <table className="data-table">
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (j === 0 ? <th key={j} scope="row" style={{ fontWeight: 500 }}>{v}</th> : <td key={j}>{v}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Explain summary="Como este número é calculado">{method}</Explain>
      </div>
    </figure>
  );
}

/** Teto "redondo" para contagens, escolhido para que as marcas do eixo sejam sempre inteiras. */
function niceMax(v: number): number {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  for (const c of [6, 8, 10]) if (v <= c) return c;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Marcas do eixo de contagens: todos os inteiros até 4; acima disso, zero, metade e teto (inteiros). */
function countTicks(max: number): number[] {
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i);
  return [0, max / 2, max];
}

function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M ${x} ${y + h} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h} Z`;
}

export interface TrackColumn {
  label: string;
  fullLabel: string;
  track: number;
  fill: number;
  future?: boolean;
  tooltip: string;
}

/** Colunas com trilho (previstas) e preenchimento (concluídas), alinhadas na mesma linha de base. */
export function TrackColumnChart({ columns, ariaLabel, height = 200 }: { columns: TrackColumn[]; ariaLabel: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 12, right: 8, bottom: 26, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...columns.map((c) => Math.max(c.track, c.fill))));
  const band = innerW / Math.max(1, columns.length);
  const colW = Math.max(3, Math.min(24, band * 0.62));
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(columns.length / Math.floor(innerW / 34)));
  const ticks = countTicks(max);

  return (
    <div className="chart-plot" ref={ref}>
      <svg
        className="chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.floor((e.clientX - rect.left - pad.left) / band);
          setHover(i >= 0 && i < columns.length ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'axis' : 'grid'} x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text x={pad.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central">
              {Number.isInteger(t) ? t : t.toFixed(1).replace('.', ',')}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          const x = pad.left + i * band + (band - colW) / 2;
          return (
            <g key={i} opacity={hover !== null && hover !== i ? 0.55 : 1}>
              {!c.future && c.track > 0 && <path d={columnPath(x, y(c.track), colW, y(0) - y(c.track))} fill="var(--chart-track)" opacity={0.55} />}
              {!c.future && c.fill > 0 && <path d={columnPath(x, y(c.fill), colW, y(0) - y(c.fill))} fill="var(--chart-done)" />}
              {i % labelEvery === 0 && (
                <text x={x + colW / 2} y={height - 8} textAnchor="middle">
                  {c.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && columns[hover] && (
        <div className="chart-tooltip" style={{ left: pad.left + hover * band + band / 2, top: y(Math.max(columns[hover].track, columns[hover].fill, 0)) }}>
          <strong>{columns[hover].fullLabel}</strong>
          <br />
          {columns[hover].tooltip}
        </div>
      )}
    </div>
  );
}

export interface LineSeries {
  name: string;
  color: string;
  values: Array<number | null>;
  format: (v: number) => string;
}

/** Linhas de 2 px com marcadores; valores nulos viram lacunas (sem interpolação inventada). */
export function LineChart({
  labels,
  fullLabels,
  series,
  domain,
  ariaLabel,
  height = 200,
  tickFormat,
}: {
  labels: string[];
  fullLabels: string[];
  series: LineSeries[];
  domain: [number, number];
  ariaLabel: string;
  height?: number;
  tickFormat: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 14, right: series.length > 1 ? 64 : 16, bottom: 26, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = labels.length;
  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - ((v - domain[0]) / (domain[1] - domain[0])) * innerH;
  const ticks = [domain[0], (domain[0] + domain[1]) / 2, domain[1]];
  const labelEvery = Math.max(1, Math.ceil(n / Math.floor(innerW / 34)));

  const segments = (values: Array<number | null>) => {
    const out: string[] = [];
    let current = '';
    values.forEach((v, i) => {
      if (v === null) {
        if (current) out.push(current);
        current = '';
        return;
      }
      current += `${current ? ' L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    });
    if (current) out.push(current);
    return out;
  };

  return (
    <div className="chart-plot" ref={ref}>
      <svg
        className="chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = (e.clientX - rect.left - pad.left) / Math.max(1, innerW);
          const i = Math.round(rel * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === domain[0] ? 'axis' : 'grid'} x1={pad.left} x2={pad.left + innerW} y1={y(t)} y2={y(t)} />
            <text x={pad.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central">
              {tickFormat(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={x(i)} y={height - 8} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        {hover !== null && <line className="grid" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} style={{ stroke: 'var(--chart-axis)' }} />}
        {series.map((s) => (
          <g key={s.name}>
            {segments(s.values).map((d, k) => (
              <path key={k} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {s.values.map((v, i) =>
              v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />,
            )}
            {series.length > 1 &&
              (() => {
                const lastIndex = [...s.values.keys()].reverse().find((i) => s.values[i] !== null);
                if (lastIndex === undefined) return null;
                return (
                  <text x={x(lastIndex) + 8} y={y(s.values[lastIndex]!)} dominantBaseline="central" style={{ fill: 'var(--ink-2)', fontWeight: 600 }}>
                    {s.name}
                  </text>
                );
              })()}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div className="chart-tooltip" style={{ left: x(hover), top: pad.top + 8 }}>
          <strong>{fullLabels[hover]}</strong>
          {series.map((s) => (
            <span key={s.name} style={{ display: 'block' }}>
              {s.name}: {s.values[hover] === null ? 'sem dado' : s.format(s.values[hover]!)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface MeterRow {
  id: string;
  label: ReactNode;
  value: number;
  max: number;
  valueLabel: string;
  marker?: number;
  markerLabel?: string;
  /** `danger`: a barra fica vermelha (ex.: passou do limite). */
  tone?: 'danger';
}

/** Barras horizontais (medidores) — leitura direta por lista, acessível sem o gráfico. */
export function MeterList({ rows, ariaLabel }: { rows: MeterRow[]; ariaLabel: string }) {
  return (
    <ul className="meter-list" aria-label={ariaLabel}>
      {rows.map((r) => {
        const pct = r.max > 0 ? Math.min(100, (r.value / r.max) * 100) : 0;
        const mk = r.marker !== undefined && r.max > 0 ? Math.min(100, (r.marker / r.max) * 100) : undefined;
        return (
          <li key={r.id} className="meter-row">
            <div className="meter-top">
              <span className="meter-name">{r.label}</span>
              <span className="num small">{r.valueLabel}</span>
            </div>
            <div className={`meter${r.tone === 'danger' ? ' is-over' : ''}`} aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
              {mk !== undefined && <i style={{ left: `calc(${mk}% - 1px)` }} title={r.markerLabel} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface ColumnSeries {
  name: string;
  color: string;
  values: number[];
}

/**
 * Colunas agrupadas (uma por série em cada rótulo), na mesma linha de base — ex.: entradas × gastos
 * por mês. Valores não negativos; o eixo usa `tickFormat` e o tooltip, `valueFormat`.
 */
export function ColumnChart({
  labels,
  fullLabels,
  series,
  ariaLabel,
  height = 220,
  tickFormat,
  valueFormat,
}: {
  labels: string[];
  fullLabels: string[];
  series: ColumnSeries[];
  ariaLabel: string;
  height?: number;
  tickFormat: (v: number) => string;
  valueFormat: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 12, right: 8, bottom: 26, left: 58 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = Math.max(1, labels.length);
  const rawMax = Math.max(0, ...series.flatMap((s) => s.values));
  const max = rawMax > 0 ? niceMax(rawMax) : 1;
  const band = innerW / n;
  const groupW = band * 0.72;
  const colW = Math.max(2, Math.min(24, groupW / Math.max(1, series.length) - (series.length > 1 ? 2 : 0)));
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 34))));
  const ticks = [0, max / 2, max];

  return (
    <div className="chart-plot" ref={ref}>
      <svg
        className="chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.floor((e.clientX - rect.left - pad.left) / band);
          setHover(i >= 0 && i < labels.length ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'axis' : 'grid'} x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text x={pad.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central">
              {tickFormat(t)}
            </text>
          </g>
        ))}
        {labels.map((label, i) => {
          const groupX = pad.left + i * band + (band - (colW * series.length + (series.length - 1) * 2)) / 2;
          return (
            <g key={i} opacity={hover !== null && hover !== i ? 0.55 : 1}>
              {series.map((s, k) => {
                const v = s.values[i] ?? 0;
                const x = groupX + k * (colW + 2);
                return v > 0 ? <path key={s.name} d={columnPath(x, y(v), colW, y(0) - y(v))} fill={s.color} /> : null;
              })}
              {i % labelEvery === 0 && (
                <text x={pad.left + i * band + band / 2} y={height - 8} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && labels[hover] !== undefined && (
        <div className="chart-tooltip" style={{ left: pad.left + hover * band + band / 2, top: y(Math.max(0, ...series.map((s) => s.values[hover] ?? 0))) }}>
          <strong>{fullLabels[hover]}</strong>
          {series.map((s) => (
            <span key={s.name} style={{ display: 'block' }}>
              {s.name}: {valueFormat(s.values[hover] ?? 0)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

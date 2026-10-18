import { formatNumber } from '../../domain/format';
import type { GoalProgress } from '../../domain/goals';
import { Tag } from '../../components/ui';

/** Exibe o progresso de uma meta só quando ele é mensurável; caso contrário, diz por quê. */
export function GoalProgressView({ progress, compact }: { progress: GoalProgress; compact?: boolean }) {
  const label = progressLabel(progress);
  return (
    <div className="meter-row">
      <div className="meter-top">
        <span className={compact ? 'meta' : 'meter-name'}>{label}</span>
        {progress.manual && progress.kind !== 'manual_completion' && <Tag tone="warn">Atualização manual</Tag>}
        {progress.reached && <Tag tone="ok">Alvo atingido</Tag>}
      </div>
      {progress.ratio !== null && progress.kind !== 'manual_completion' && (
        <div className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={progress.target ?? 0} aria-valuenow={progress.current}>
          <span style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function progressLabel(p: GoalProgress): string {
  if (p.kind === 'manual_completion') return p.reached ? 'Concluída' : 'Conclusão manual (sem alvo numérico)';
  if (p.target === null) return p.kind === 'child_goals' ? 'Sem metas filhas vinculadas' : 'Sem alvo definido';
  return `${formatNumber(p.current)} de ${formatNumber(p.target)} ${p.unit}`;
}

export type OrbPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Esfera da sessão da noite: só visual (o estado é anunciado em texto ao lado). */
export function NightOrb({ phase }: { phase: OrbPhase }) {
  return (
    <span className={`orb is-${phase}`} aria-hidden="true">
      <span className="orb-ring orb-ring-1" />
      <span className="orb-ring orb-ring-2" />
      <span className="orb-ring orb-ring-3" />
      <span className="orb-core" />
      <span className="orb-bars">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

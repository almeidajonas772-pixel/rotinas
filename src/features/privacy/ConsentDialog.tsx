import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui';
import type { ConsentKey } from '../../domain/schemas';
import { CONSENT_TEXTS } from './consent-texts';

export function ConsentDetails({ consent }: { consent: ConsentKey }) {
  const t = CONSENT_TEXTS[consent];
  return (
    <div className="stack small">
      <p>{t.summary}</p>
      <div>
        <p className="field-label">O que é enviado</p>
        <ul>
          {t.sends.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="field-label">O que nunca é enviado</p>
        <ul>
          {t.neverSends.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <p>
        <strong>Para onde:</strong> {t.destination}
      </p>
      <p>
        <strong>Quando:</strong> {t.when}
      </p>
      <p>
        <strong>Como revogar:</strong> {t.revoke}
      </p>
    </div>
  );
}

/** Pede uma autorização específica, mostrando exatamente o que será enviado e para onde. */
export function ConsentDialog({
  consent,
  open,
  onClose,
  onDecide,
  busy,
}: {
  consent: ConsentKey;
  open: boolean;
  onClose: () => void;
  onDecide: (granted: boolean) => void | Promise<void>;
  busy?: boolean;
}) {
  const t = CONSENT_TEXTS[consent];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Autorizar: ${t.title}`}
      footer={
        <>
          <Button onClick={() => void onDecide(false)}>Agora não</Button>
          <Button variant="primary" busy={busy} onClick={() => void onDecide(true)}>
            Autorizar
          </Button>
        </>
      }
    >
      <ConsentDetails consent={consent} />
    </Dialog>
  );
}

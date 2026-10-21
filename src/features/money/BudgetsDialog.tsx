import { useState } from 'react';
import { Dialog } from '../../components/dialog';
import { TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { describeError } from '../../db/errors';
import { setBudget } from '../../db/repo-money';
import { byCategory, categoryKey, categoryOptions, formatMoney, moneyInputValue, parseMoney } from '../../domain/money';
import type { Budget, MoneyEntry } from '../../domain/schemas';

/** Limites mensais por categoria de gasto. Campo vazio = sem limite. */
export function BudgetsDialog({ entries, monthEntries, monthLabel, budgets, onClose }: { entries: readonly MoneyEntry[]; monthEntries: readonly MoneyEntry[]; monthLabel: string; budgets: readonly Budget[]; onClose: () => void }) {
  const toast = useToast();
  const byKey = new Map(budgets.map((b) => [b.id, b]));
  const names = categoryOptions(entries, 'expense');
  for (const b of budgets) if (!names.some((n) => categoryKey(n) === b.id)) names.push(b.category);
  const spent = new Map(byCategory(monthEntries, 'expense').map((c) => [c.key, c.cents]));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(budgets.map((b) => [b.id, moneyInputValue(b.monthlyLimitCents)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    const errs: Record<string, string> = {};
    const changes: Array<{ name: string; cents: number | null }> = [];
    for (const name of names) {
      const key = categoryKey(name);
      const text = (values[key] ?? '').trim();
      const current = byKey.get(key)?.monthlyLimitCents ?? null;
      if (!text) {
        if (current !== null) changes.push({ name, cents: null });
        continue;
      }
      const cents = parseMoney(text);
      if (cents === null || cents < 100) errs[key] = 'Use um valor de pelo menos 1,00';
      else if (cents !== current) changes.push({ name, cents });
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      for (const c of changes) await setBudget(c.name, c.cents);
      toast.show(changes.length === 0 ? 'Nada mudou.' : 'Limites salvos.');
      onClose();
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Limites mensais"
      description="Quanto você quer gastar, no máximo, em cada categoria por mês. Deixe vazio para não ter limite. O app avisa quando você chegar a 80% e quando passar."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Salvar limites
          </Button>
        </>
      }
    >
      <div className="stack">
        {names.map((name) => {
          const key = categoryKey(name);
          return (
            <TextField
              key={key}
              label={name}
              optional
              value={values[key] ?? ''}
              onChange={(v) => setValues({ ...values, [key]: v })}
              inputMode="decimal"
              autoComplete="off"
              placeholder="Sem limite"
              error={errors[key]}
              hint={`Gasto em ${monthLabel}: ${formatMoney(spent.get(key) ?? 0)}`}
            />
          );
        })}
      </div>
    </Dialog>
  );
}

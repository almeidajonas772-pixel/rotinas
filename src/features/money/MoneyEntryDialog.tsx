import { Plus, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../../app/context';
import { Dialog } from '../../components/dialog';
import { Segmented, SelectField, TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { describeError } from '../../db/errors';
import { deleteMoneyEntry, saveMoneyEntry } from '../../db/repo-money';
import { isCivilDate } from '../../domain/civil';
import { categoryKey, categoryOptions, formatMoney, moneyInputValue, NECESSITY_LABEL, parseMoney, PAYMENT_LABEL } from '../../domain/money';
import type { MoneyEntry, MoneyKind, Necessity, PaymentMethod } from '../../domain/schemas';

const AMOUNT_ID = 'money-amount';

/** Registrar ou editar um gasto/entrada. Pensado para ser rápido: valor, categoria e pronto. */
export function MoneyEntryDialog({ initialKind, entry, entries, onClose }: { initialKind: MoneyKind; entry?: MoneyEntry; entries: readonly MoneyEntry[]; onClose: () => void }) {
  const { today } = useApp();
  const toast = useToast();
  const [kind, setKind] = useState<MoneyKind>(entry?.kind ?? initialKind);
  const [amount, setAmount] = useState(entry ? moneyInputValue(entry.amountCents) : '');
  const [category, setCategory] = useState(entry?.category ?? '');
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [date, setDate] = useState(entry?.date ?? today);
  const [description, setDescription] = useState(entry?.description ?? '');
  const [method, setMethod] = useState<PaymentMethod | ''>(entry?.method ?? '');
  const [necessity, setNecessity] = useState<Necessity | undefined>(entry?.necessity);
  const [errors, setErrors] = useState<{ amount?: string; category?: string; date?: string }>({});
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const options = useMemo(() => categoryOptions(entries, kind), [entries, kind]);

  function changeKind(next: MoneyKind) {
    setKind(next);
    // Mantém a categoria só se ela também existir para o outro tipo (ex.: Negócios, Presentes, Outros).
    if (category && !categoryOptions(entries, next).some((c) => categoryKey(c) === categoryKey(category))) setCategory('');
  }

  async function save(again: boolean) {
    const cents = parseMoney(amount);
    const cat = (customOpen ? customName : category).trim();
    const errs: typeof errors = {};
    if (cents === null || cents <= 0) errs.amount = 'Digite um valor, por exemplo 12,50';
    if (!cat) errs.category = customOpen ? 'Dê um nome à categoria' : 'Escolha uma categoria';
    if (!isCivilDate(date)) errs.date = 'Data inválida';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || cents === null) return;
    setBusy(true);
    try {
      await saveMoneyEntry({ kind, amountCents: cents, date, category: cat, description, method: method || undefined, necessity }, entry?.id);
      toast.show(entry ? 'Lançamento atualizado.' : kind === 'expense' ? `Gasto de ${formatMoney(cents)} registrado.` : `Entrada de ${formatMoney(cents)} registrada.`);
      if (again) {
        setAmount('');
        setDescription('');
        setNecessity(undefined);
        if (customOpen) {
          setCategory(cat);
          setCustomOpen(false);
          setCustomName('');
        }
        document.getElementById(AMOUNT_ID)?.focus();
      } else onClose();
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!entry) return;
    setBusy(true);
    try {
      await deleteMoneyEntry(entry.id);
      toast.show('Lançamento excluído.');
      onClose();
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
      setBusy(false);
    }
  }

  const title = entry ? 'Editar lançamento' : kind === 'expense' ? 'Novo gasto' : 'Nova entrada';
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        confirmDelete ? (
          <>
            <span className="small grow">Excluir este lançamento?</span>
            <Button onClick={() => setConfirmDelete(false)}>Cancelar</Button>
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              Excluir
            </Button>
          </>
        ) : (
          <>
            {entry && (
              <Button variant="ghost" icon={<Trash size={16} aria-hidden="true" />} onClick={() => setConfirmDelete(true)}>
                Excluir
              </Button>
            )}
            <Button onClick={onClose}>Cancelar</Button>
            {!entry && (
              <Button icon={<Plus size={16} aria-hidden="true" />} disabled={busy} onClick={() => void save(true)}>
                Salvar e adicionar outro
              </Button>
            )}
            <Button variant="primary" busy={busy} onClick={() => void save(false)}>
              Salvar
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <Segmented label="Tipo" value={kind} onChange={changeKind} options={[{ value: 'expense', label: 'Gasto' }, { value: 'income', label: 'Entrada' }]} />
        <TextField
          id={AMOUNT_ID}
          label="Valor (R$)"
          value={amount}
          onChange={setAmount}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          autoFocus
          error={errors.amount}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save(false);
            }
          }}
        />
        <fieldset>
          <legend className="field-label">Categoria</legend>
          <div className="chips">
            {options.map((c) => (
              <button
                key={c}
                type="button"
                className="chip"
                aria-pressed={!customOpen && categoryKey(c) === categoryKey(category)}
                onClick={() => {
                  setCategory(c);
                  setCustomOpen(false);
                }}
              >
                {c}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={customOpen} onClick={() => setCustomOpen(!customOpen)}>
              <Plus size={14} aria-hidden="true" /> Outra
            </button>
          </div>
          {customOpen && <TextField label="Nome da nova categoria" value={customName} onChange={setCustomName} maxLength={40} autoComplete="off" />}
          {errors.category && (
            <p className="field-error" role="alert">
              {errors.category}
            </p>
          )}
        </fieldset>
        <div className="field-row">
          <TextField label="Data" type="date" value={date} onChange={setDate} error={errors.date} />
          {kind === 'expense' && (
            <SelectField
              label="Forma de pagamento"
              optional
              value={method}
              onChange={(v) => setMethod(v as PaymentMethod | '')}
              options={[{ value: '', label: 'Não informar' }, ...(Object.entries(PAYMENT_LABEL) as Array<[PaymentMethod, string]>).map(([value, label]) => ({ value, label }))]}
            />
          )}
        </div>
        <TextField label="Descrição" optional value={description} onChange={setDescription} maxLength={120} placeholder={kind === 'expense' ? 'Ex.: lanche depois da aula' : 'Ex.: venda de camisetas'} />
        {kind === 'expense' && (
          <fieldset>
            <legend className="field-label">Era necessário? (opcional)</legend>
            <p className="field-hint" style={{ marginBottom: 6 }}>
              Ajuda a ver quanto vai para coisas supérfluas.
            </p>
            <div className="chips">
              {(Object.entries(NECESSITY_LABEL) as Array<[Necessity, string]>).map(([value, label]) => (
                <button key={value} type="button" className="chip" aria-pressed={necessity === value} onClick={() => setNecessity(necessity === value ? undefined : value)}>
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

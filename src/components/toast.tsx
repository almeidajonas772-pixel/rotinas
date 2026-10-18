import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  tone: 'neutral' | 'danger';
  action?: { label: string; onSelect: () => void };
}

interface ToastApi {
  show: (message: string, options?: { tone?: 'neutral' | 'danger'; action?: { label: string; onSelect: () => void } }) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback<ToastApi['show']>(
    (message, options) => {
      counter.current += 1;
      const id = counter.current;
      setItems((list) => [...list.slice(-2), { id, message, tone: options?.tone ?? 'neutral', action: options?.action }]);
      window.setTimeout(() => dismiss(id), options?.action ? 7000 : 4500);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'danger' ? ' is-danger' : ''}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onSelect();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

import { useEffect } from 'react';

import { useAdd } from '../components/AddContext.tsx';
import { useQuickAdd } from '../planned/queries.ts';
import { useAccounts, useCategories } from '../queries.ts';
import { AddTransactionForm } from './AddTransactionForm.tsx';

export const AddTransactionDrawer = () => {
  const { prefill, closeAdd } = useAdd();
  const accounts = useAccounts();
  const categories = useCategories();
  const quickAdd = useQuickAdd();

  // Focus goes to the amount field inside the form, so it is not taken here.
  useEffect(() => {
    if (prefill === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAdd();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefill, closeAdd]);

  if (prefill === null) return null;
  return (
    <>
      <div className="scrim" onClick={closeAdd} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <div className="drawer-head">
          <h3 id="add-title">Новий запис</h3>
          <button type="button" className="close" aria-label="Закрити" onClick={closeAdd}>
            ✕
          </button>
        </div>
        {/* Waits for the history-based defaults too (a failed load just means none), so they are there on first paint. */}
        {accounts.data !== undefined && categories.data !== undefined && !quickAdd.isPending && (
          <AddTransactionForm
            key={JSON.stringify(prefill)}
            accounts={accounts.data}
            categories={categories.data}
            prefill={prefill}
            quickAdd={quickAdd.data}
          />
        )}
      </aside>
    </>
  );
};

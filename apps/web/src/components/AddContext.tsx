import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

import type { AddDraft } from '../overview/AddTransactionForm.tsx';

type AddApi = { prefill: Partial<AddDraft> | null; openAdd: (prefill?: Partial<AddDraft>) => void; closeAdd: () => void };

const AddContext = createContext<AddApi>({ prefill: null, openAdd: () => {}, closeAdd: () => {} });

/** One «+ Запис» for the whole app: the header button, the phone nav and «записати» on expected payments. */
export const AddProvider = ({ children }: { children: ReactNode }) => {
  const [prefill, setPrefill] = useState<Partial<AddDraft> | null>(null);
  const api = useMemo<AddApi>(
    () => ({ prefill, openAdd: (next = {}) => setPrefill(next), closeAdd: () => setPrefill(null) }),
    [prefill],
  );
  return <AddContext value={api}>{children}</AddContext>;
};

export const useAdd = () => useContext(AddContext);

import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

type DrawerApi = { openId: string | null; openTransaction: (id: string) => void; close: () => void };

const DrawerContext = createContext<DrawerApi>({ openId: null, openTransaction: () => {}, close: () => {} });

/** `?tx=<id>` in the address opens a row straight away, so an explanation can be linked to. */
const readLinkedId = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tx');

export const DrawerProvider = ({ children }: { children: ReactNode }) => {
  const [openId, setOpenId] = useState<string | null>(readLinkedId);
  const api = useMemo<DrawerApi>(() => ({ openId, openTransaction: setOpenId, close: () => setOpenId(null) }), [openId]);
  return <DrawerContext value={api}>{children}</DrawerContext>;
};

export const useDrawer = () => useContext(DrawerContext);

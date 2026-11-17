import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import './styles/shell.css';
import './styles/trends.css';
import './styles/ledger.css';
import './styles/investments.css';
import './styles/review.css';
import './styles/planned.css';
import './styles/manage.css';
import './styles/capital.css';
import './styles/marks.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { AddProvider } from './components/AddContext.tsx';
import { DrawerProvider } from './components/DrawerContext.tsx';
import { applyTheme, readStoredTheme } from './components/theme.ts';
import { TooltipProvider } from './components/Tooltip.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

// Before the first paint, so a stored light or dark theme never flashes the other one.
applyTheme(readStoredTheme());

const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DrawerProvider>
          <AddProvider>
            <App />
          </AddProvider>
        </DrawerProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);

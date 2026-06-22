import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { SIDEPANEL_PORT } from '@/lib/messaging';
import '@/design/global.css';

// Tell the background this panel is open (it broadcasts to calendar tabs so the
// in-page button hides). The port auto-disconnects when the panel closes.
chrome.runtime.connect({ name: SIDEPANEL_PORT });

// Server state lives in TanStack Query: optimistic toggles + background refetch.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

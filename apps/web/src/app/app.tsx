import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

import { ApiRequestError } from '../shared/api/client.js';
import { SessionProvider } from '../features/auth/session.js';
import { AppRoutes } from './routes.js';

/**
 * Query defaults, set once.
 *
 * Retrying a refusal is the mistake worth designing out. A 400 will be refused
 * identically on the second attempt, and a 403 on the third — retrying turns
 * one clear message into a delay followed by the same message, and on a
 * rate-limited endpoint it spends the caller's remaining allowance.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiRequestError && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

export function App(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <AppRoutes />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

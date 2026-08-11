import { type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';

import { SignInPage } from '../features/auth/sign-in-page.js';
import { ClientsPage } from '../features/clients/clients-page.js';
import { NewClientPage } from '../features/clients/new-client-page.js';
import { LoanPage } from '../features/loans/loan-page.js';
import { LoansPage } from '../features/loans/loans-page.js';
import { NewLoanPage } from '../features/loans/new-loan-page.js';
import { ReportsPage } from '../features/reports/reports-page.js';
import { RequirePermission, RequireSession } from './guards.js';
import { Shell } from './shell.js';

/**
 * Every route the app has.
 *
 * Each authenticated route is wrapped twice: `RequireSession` for who you are,
 * `RequirePermission` for whether you may. A route reachable without a
 * permission it needs would render a page whose every request fails, which is
 * the degraded screen the previous build showed an officer who opened
 * `/settings` (App Flow §1).
 */
export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />

      <Route
        element={
          <RequireSession>
            <Shell />
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="/clients" replace />} />

        <Route
          path="/clients"
          element={
            <RequirePermission permission="client.read">
              <ClientsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/clients/new"
          element={
            <RequirePermission permission="client.create">
              <NewClientPage />
            </RequirePermission>
          }
        />

        <Route
          path="/loans"
          element={
            <RequirePermission permission="loan.read">
              <LoansPage />
            </RequirePermission>
          }
        />
        <Route
          path="/loans/new"
          element={
            <RequirePermission permission="loan.create">
              <NewLoanPage />
            </RequirePermission>
          }
        />
        <Route
          path="/loans/:id"
          element={
            <RequirePermission permission="loan.read">
              <LoanPage />
            </RequirePermission>
          }
        />

        <Route
          path="/reports"
          element={
            <RequirePermission permission="report.generate">
              <ReportsPage />
            </RequirePermission>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/clients" replace />} />
    </Routes>
  );
}

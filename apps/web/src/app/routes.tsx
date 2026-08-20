import { type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';

import { AuditPage } from '../features/audit/audit-page.js';
import { SignInPage } from '../features/auth/sign-in-page.js';
import { ClientsPage } from '../features/clients/clients-page.js';
import { ComplaintsPage } from '../features/complaints/complaints-page.js';
import { NewClientPage } from '../features/clients/new-client-page.js';
import { LoanPage } from '../features/loans/loan-page.js';
import { LoansPage } from '../features/loans/loans-page.js';
import { NewLoanPage } from '../features/loans/new-loan-page.js';
import { BankBalancesPage } from '../features/finance/bank-balances-page.js';
import { FinancePage } from '../features/finance/finance-page.js';
import { PortfolioPage } from '../features/portfolio/portfolio-page.js';
import { ReportsPage } from '../features/reports/reports-page.js';
import { SavingsPage } from '../features/savings/savings-page.js';
import { SettingsPage } from '../features/settings/settings-page.js';
import { StatementsPage } from '../features/statements/statements-page.js';
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
          path="/finance"
          element={
            <RequirePermission permission="expense.read">
              <FinancePage />
            </RequirePermission>
          }
        />
        <Route
          path="/finance/banks"
          element={
            <RequirePermission permission="expense.read">
              <BankBalancesPage />
            </RequirePermission>
          }
        />

        <Route
          path="/statements"
          element={
            <RequirePermission permission="expense.read">
              <StatementsPage />
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

        <Route
          path="/portfolio"
          element={
            <RequirePermission permission="loan.read">
              <PortfolioPage />
            </RequirePermission>
          }
        />

        <Route
          path="/savings"
          element={
            <RequirePermission permission="savings.read">
              <SavingsPage />
            </RequirePermission>
          }
        />

        {/* `audit.read` is held by the administrator and the auditor, and the
            policy on `audit_logs` checks the same permission — so a role that
            reached this route anyway would see an empty trail rather than
            someone else's history. */}
        <Route
          path="/audit"
          element={
            <RequirePermission permission="audit.read">
              <AuditPage />
            </RequirePermission>
          }
        />

        <Route
          path="/complaints"
          element={
            <RequirePermission permission="complaint.read">
              <ComplaintsPage />
            </RequirePermission>
          }
        />

        {/* `settings.manage` rather than a read permission: every control on
            this screen writes, and a read-only view of it would be a page whose
            only two buttons both fail. */}
        <Route
          path="/settings"
          element={
            <RequirePermission permission="settings.manage">
              <SettingsPage />
            </RequirePermission>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/clients" replace />} />
    </Routes>
  );
}

import { Outlet } from 'react-router-dom';

export function AppLayout() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <Outlet />
    </main>
  );
}

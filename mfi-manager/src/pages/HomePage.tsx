import { Link } from 'react-router-dom';

export function HomePage() {
  return (
    <section className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm sm:p-12">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.3em] text-emerald-700">
          Tanzanian Tier II MFIs
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-slate-950 sm:text-6xl">
          MFI Manager
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-8 text-slate-600">
          Microfinance Institution Management System
        </p>
        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            to="/login"
            className="rounded-full bg-emerald-700 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2"
          >
            Login
          </Link>
          <Link
            to="/signup"
            className="rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-800 transition hover:border-emerald-700 hover:text-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2"
          >
            Signup
          </Link>
        </div>
      </div>
    </section>
  );
}

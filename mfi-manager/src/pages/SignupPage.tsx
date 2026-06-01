import { Link } from 'react-router-dom';

export function SignupPage() {
  return (
    <section className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-700">
          MFI Manager
        </p>
        <h1 className="mt-3 text-3xl font-bold text-slate-950">Signup</h1>
        <p className="mt-4 text-slate-600">Signup page placeholder.</p>
        <Link className="mt-8 inline-flex text-sm font-semibold text-emerald-700" to="/">
          Back to home
        </Link>
      </div>
    </section>
  );
}

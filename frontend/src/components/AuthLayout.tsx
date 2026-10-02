import { type ReactNode } from 'react';
import ThemeToggle from '@/components/ThemeToggle';
import { APP_VERSION } from '@/lib/appVersion';

export default function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f7f8fa] dark:bg-[#09090b] text-gray-900 dark:text-gray-100 antialiased">
      <div className="fixed top-4 right-4 z-20">
        <ThemeToggle className="rounded-xl border border-gray-200/80 dark:border-white/10 bg-white/80 dark:bg-[#121212]/80 backdrop-blur" />
      </div>
      <main className="min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]">
        <section className="hidden lg:flex relative overflow-hidden p-12 xl:p-16 flex-col justify-between bg-gray-950 text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(139,92,246,.28),transparent_30%),radial-gradient(circle_at_80%_70%,rgba(59,130,246,.20),transparent_32%)]" />
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center">
              <span className="text-black font-bold text-sm">DX</span>
            </div>
            <span className="font-semibold">DomX</span>
          </div>
          <div className="relative max-w-xl">
            <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[.16em] text-white/50">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              SECURE OPERATIONS WORKSPACE
            </span>
            <h1 className="mt-5 text-4xl xl:text-5xl font-semibold tracking-tight leading-tight text-white">
              Authorized personnel only.
            </h1>
            <p className="mt-5 text-sm text-white/60 max-w-lg">
              Access to this system is restricted. Unauthorized access, attempted access, or misuse may be monitored, recorded, and subject to disciplinary or legal action. Proceed only if you have been granted permission.  
            </p>
          </div>
          <p className="relative text-xs text-white/35">DomX Agency OÜ · 2026</p>
        </section>
        <section className="flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-[430px]">
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-gray-900 dark:bg-white rounded-xl flex items-center justify-center">
                <span className="text-white dark:text-black font-bold text-sm">DX</span>
              </div>
              <div>
                <div className="font-semibold">DomX</div>
                <div className="text-xs text-gray-500">Operations workspace</div>
              </div>
            </div>
            <div className="surface-card p-6 sm:p-8 shadow-soft">
              <div className="mb-7">
                <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
                <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
              </div>
              {children}
            </div>
            <p className="mt-5 text-center text-xs text-gray-400">
              DomX Agency OÜ © 2026 · v{APP_VERSION}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import type { FanScrapeLogEntry } from '@/lib/api';

function logClassName(text: string): string {
  if (text.startsWith('+')) return 'text-emerald-400';
  if (text.includes('FAILED')) return 'text-red-400';
  if (text.includes('SKIPPED')) return 'text-amber-400';
  return 'text-zinc-400';
}

export default function FanScrapeActivityLog({
  logs,
}: {
  logs?: FanScrapeLogEntry[] | string[] | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lines = (logs || [])
    .map((item) => (typeof item === 'string' ? item : item?.text || ''))
    .filter(Boolean);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
          Activity log
        </h3>
        <span className="text-[11px] text-gray-400 dark:text-zinc-500">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        ref={scrollerRef}
        className="h-56 overflow-y-auto rounded-xl border border-gray-200 dark:border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-5"
      >
        {lines.length === 0 ? (
          <p className="text-zinc-500">Waiting for activity…</p>
        ) : (
          lines.map((line, index) => (
            <div key={`${index}-${line}`} className={logClassName(line)}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

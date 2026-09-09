const btnClass =
  'px-2 py-1 rounded-lg text-[11px] font-medium border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed';

export default function AiIgnoreStrip({
  aiIgnored,
  busy,
  error,
  onIgnore,
  onUnignore,
}: {
  aiIgnored: boolean;
  busy?: boolean;
  error?: string | null;
  onIgnore: () => void;
  onUnignore: () => void;
}) {
  if (aiIgnored) {
    return (
      <div className="mb-2 rounded-xl border border-amber-200/80 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
        <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
          AI ignored for this fan — no drafts, no auto-send
        </p>
        <button
          type="button"
          className={`${btnClass} mt-1.5`}
          disabled={busy}
          onClick={onUnignore}
        >
          Un-ignore
        </button>
        {error ? <p className="mt-1 text-[11px] text-red-500">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <button
        type="button"
        className={btnClass}
        disabled={busy}
        onClick={onIgnore}
      >
        Ignore AI
      </button>
      {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
    </div>
  );
}

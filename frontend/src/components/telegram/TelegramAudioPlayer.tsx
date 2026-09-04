import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Loader2, Mic, Pause, Play } from 'lucide-react';

export function formatAudioDuration(seconds?: number | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function TelegramVoiceTile({
  duration,
  className = '',
}: {
  duration?: number | null;
  className?: string;
}) {
  const show =
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
  return (
    <div
      className={`w-full h-full flex flex-col items-center justify-center gap-1 bg-gray-100 dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 ${className}`}
    >
      <Mic className="w-6 h-6" />
      {show && (
        <span className="text-[10px] font-medium">{formatAudioDuration(duration)}</span>
      )}
    </div>
  );
}

let activeStop: (() => void) | null = null;

export type TelegramAudioPlayerVariant = 'outgoing' | 'incoming' | 'neutral';

export default function TelegramAudioPlayer({
  src,
  duration,
  fileName,
  variant = 'neutral',
}: {
  src: string;
  duration?: number | null;
  fileName?: string | null;
  variant?: TelegramAudioPlayerVariant;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(
    typeof duration === 'number' && duration > 0 ? duration : 0
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setLoading(false);
    setCurrent(0);
    setTotal(typeof duration === 'number' && duration > 0 ? duration : 0);
    setError(false);
  }, [src, duration]);

  useEffect(() => {
    const stop = () => {
      const el = audioRef.current;
      if (el) el.pause();
      setPlaying(false);
      setLoading(false);
    };
    stopRef.current = stop;
    return () => {
      stop();
      if (activeStop === stop) activeStop = null;
    };
  }, [src]);

  async function togglePlay() {
    const el = audioRef.current;
    if (!el || error) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      if (activeStop === stopRef.current) activeStop = null;
      return;
    }
    if (activeStop && activeStop !== stopRef.current) activeStop();
    activeStop = stopRef.current;
    setLoading(true);
    try {
      await el.play();
      setPlaying(true);
    } catch {
      setError(true);
      if (activeStop === stopRef.current) activeStop = null;
    } finally {
      setLoading(false);
    }
  }

  function seek(event: MouseEvent<HTMLButtonElement>) {
    const el = audioRef.current;
    if (!el || total <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const next = Math.max(0, Math.min(total, ratio * total));
    el.currentTime = next;
    setCurrent(next);
  }

  const tone =
    variant === 'outgoing'
      ? 'text-white'
      : 'text-gray-800 dark:text-zinc-100';
  const btn =
    variant === 'outgoing'
      ? 'bg-white/20 hover:bg-white/30 text-white'
      : 'bg-gray-200 dark:bg-zinc-700 hover:bg-gray-300 dark:hover:bg-zinc-600 text-gray-800 dark:text-zinc-100';
  const bar =
    variant === 'outgoing' ? 'bg-white/30' : 'bg-gray-200 dark:bg-zinc-700';
  const fill = variant === 'outgoing' ? 'bg-white' : 'bg-sky-500';
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  const shown = playing || current > 0 ? current : total;

  return (
    <div className={`flex items-center gap-2 min-w-[180px] max-w-[280px] ${tone}`}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={() => setCurrent(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => {
          const next = audioRef.current?.duration;
          if (next && Number.isFinite(next) && next > 0) setTotal(next);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (activeStop === stopRef.current) activeStop = null;
        }}
        onError={() => setError(true)}
      />
      <button
        type="button"
        onClick={() => void togglePlay()}
        disabled={error}
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${btn} disabled:opacity-50`}
        aria-label={playing ? 'Pause audio' : 'Play audio'}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : playing ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4 ml-0.5" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        {fileName ? (
          <p className="truncate text-[11px] font-medium leading-tight mb-0.5">{fileName}</p>
        ) : null}
        <button
          type="button"
          className={`block h-1.5 w-full rounded-full overflow-hidden ${bar}`}
          aria-label="Seek"
          onClick={seek}
        >
          <span
            className={`block h-full rounded-full ${fill}`}
            style={{ width: `${pct}%` }}
          />
        </button>
        <p className="text-[10px] mt-0.5 opacity-80">
          {error ? 'Unable to play' : formatAudioDuration(shown)}
        </p>
      </div>
    </div>
  );
}

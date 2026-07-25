import { useCallback, useSyncExternalStore } from 'react';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'color-theme';

function readIsDark(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

let currentIsDark = typeof document !== 'undefined' ? readIsDark() : false;
const listeners = new Set<() => void>();
let listening = false;

function emit() {
  for (const listener of listeners) listener();
}

function ensureListening() {
  if (listening || typeof window === 'undefined') return;
  listening = true;

  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    const next = event.newValue === 'dark';
    if (next !== currentIsDark) {
      applyTheme(next, false);
    }
  });

  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      const next = readIsDark();
      if (next !== currentIsDark) {
        currentIsDark = next;
        emit();
      }
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}

function applyTheme(isDark: boolean, persist: boolean) {
  if (typeof document === 'undefined') return;
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  if (persist && typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, isDark ? 'dark' : 'light');
  }
  currentIsDark = isDark;
  emit();
}

function subscribe(listener: () => void) {
  ensureListening();
  listeners.add(listener);

  // Align with DOM (covers FOUC script that ran before React).
  const initial = readIsDark();
  if (initial !== currentIsDark) {
    currentIsDark = initial;
    emit();
  }

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentIsDark;
}

function getServerSnapshot() {
  return false;
}

export function useTheme() {
  const isDark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = useCallback((theme: Theme) => {
    applyTheme(theme === 'dark', true);
  }, []);

  const toggleTheme = useCallback(() => {
    applyTheme(!currentIsDark, true);
  }, []);

  return { isDark, setTheme, toggleTheme };
}

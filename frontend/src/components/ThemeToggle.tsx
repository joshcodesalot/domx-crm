import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const { isDark, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-darkbase-700 focus:outline-none focus:ring-2 focus:ring-brand-500 rounded-lg text-sm p-2.5 transition-colors duration-200 ${className}`}
      aria-label="Toggle theme"
    >
      {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}

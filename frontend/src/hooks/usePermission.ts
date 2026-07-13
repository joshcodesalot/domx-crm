import { useAuth } from '@/context/AuthContext';

export function usePermission(slug: string): boolean {
  const { hasPermission } = useAuth();
  return hasPermission(slug);
}

export function useAnyPermission(slugs: string[]): boolean {
  const { hasAnyPermission } = useAuth();
  return hasAnyPermission(slugs);
}

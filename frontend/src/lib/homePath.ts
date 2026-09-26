export function homePath(user: { permissions?: string[] } | null | undefined): string {
  const permissions = user?.permissions ?? [];
  if (permissions.includes('dashboard.view')) return '/dashboard';
  if (permissions.includes('marketing.view')) return '/marketing';
  return '/account/settings';
}

import { Outlet } from 'react-router-dom';

/**
 * Pass-through layout wrapper. BrowserView session warm was removed;
 * Maloum/4based chat is API-only.
 */
export function CreatorBootProvider() {
  return <Outlet />;
}

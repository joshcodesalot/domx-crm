import { useEffect, useState } from 'react';

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  );

  useEffect(() => {
    const onChange = () => {
      setVisible(document.visibilityState === 'visible');
    };
    onChange();
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

export function usePollEnabled(panelActive = true): boolean {
  const documentVisible = useDocumentVisible();
  return panelActive && documentVisible;
}

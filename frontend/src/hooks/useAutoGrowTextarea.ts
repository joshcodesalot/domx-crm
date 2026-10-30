import {
  useCallback,
  useLayoutEffect,
  useState,
  type MutableRefObject,
} from 'react';

function fitTextarea(el: HTMLTextAreaElement) {
  el.style.overflowY = 'hidden';
  el.style.minHeight = '0px';
  el.style.height = '0px';
  const full = el.scrollHeight;
  el.style.minHeight = '';
  el.style.height = `${full}px`;
  const maxHeight = Number.parseFloat(getComputedStyle(el).maxHeight);
  el.style.overflowY = Number.isFinite(maxHeight) && full > maxHeight ? 'auto' : 'hidden';
}

/**
 * Grow a textarea with its text, up to the CSS max-height, and refit when the
 * composer bar's width changes. Returns the callback ref to put on the textarea;
 * the provided ref stays in sync for focus and blur.
 */
export function useAutoGrowTextarea(
  ref: MutableRefObject<HTMLTextAreaElement | null>,
  value: string
) {
  const [node, setNode] = useState<HTMLTextAreaElement | null>(null);

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      if (el) fitTextarea(el);
      setNode(el);
    },
    [ref]
  );

  useLayoutEffect(() => {
    if (!node) return;

    fitTextarea(node);

    const bar = node.parentElement;
    if (!bar || typeof ResizeObserver === 'undefined') return;

    let lastWidth = bar.clientWidth;
    const observer = new ResizeObserver(() => {
      if (bar.clientWidth === lastWidth) return;
      lastWidth = bar.clientWidth;
      fitTextarea(node);
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [node, value]);

  return setRef;
}

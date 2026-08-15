import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, type UIEvent } from 'react';

export function VirtualizedRows<T>({
  parentRef,
  items,
  estimateSize,
  getKey,
  renderRow,
  onScroll,
  className = '',
  overscan = 8,
}: {
  parentRef: { current: HTMLDivElement | null };
  items: T[];
  estimateSize: number;
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ReactNode;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  className?: string;
  overscan?: number;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: (index) => getKey(items[index], index),
  });

  return (
    <div
      ref={parentRef}
      className={className}
      onScroll={onScroll}
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderRow(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import type { CSSProperties } from 'react';

/** Shimmer placeholder for first paint (keeps rows visible on refetch elsewhere). */
export function Skeleton({
  width = '100%',
  height = 16,
  radius,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <span
      className="skeleton"
      style={{ display: 'block', width, height, borderRadius: radius, ...style }}
    />
  );
}

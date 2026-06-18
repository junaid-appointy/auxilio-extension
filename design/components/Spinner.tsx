/** Indeterminate progress indicator (honest async feedback). */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="spinner"
      role="progressbar"
      aria-label="Loading"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * BrandMark component.
 *
 * The Mailforge mark: a solid envelope with the flap cut out as a chevron.
 * The envelope is the message; the chevron is the fold being forged into
 * shape.
 *
 * Geometry (viewBox 0 0 24 24):
 *   - Envelope: rounded rectangle from (2, 5) to (22, 19), corner radius 3.
 *   - Flap: chevron band (4.4, 8.1) -> (12, 13.7) -> (19.6, 8.1), 2.6 thick,
 *     subtracted via fill-rule="evenodd".
 *
 * Color is inherited via currentColor. Set a text color on the element or a
 * parent (e.g. text-accent) to paint it. Never hardcode a color here.
 *
 * The size prop accepts any CSS length string ("18px", "1em") or a number
 * (treated as px). Aspect ratio is always 1:1.
 *
 * Lockup rules (with the Quicksand wordmark): gap = mark size x 0.09;
 * the mark is nudged down by mark size x 0.05 to sit on the x-height
 * optical center; mark size is roughly wordmark size x 1.15 (solid fill
 * reads heavier than the wordmark strokes, so it stays smaller).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
interface BrandMarkProps {
  /** Width and height. CSS length string or number (px). Default 18px. */
  size?: number | string;
  className?: string;
}

export function BrandMark({ size = 18, className }: BrandMarkProps) {
  const dim = typeof size === "number" ? `${size}px` : size;
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M5 5 H19 A3 3 0 0 1 22 8 V16 A3 3 0 0 1 19 19 H5 A3 3 0 0 1 2 16 V8 A3 3 0 0 1 5 5 Z M4.4 8.1 L12 13.7 L19.6 8.1 L19.6 10.7 L12 16.3 L4.4 10.7 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

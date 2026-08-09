// Self-hosted SVG badge generator — no external service (shields.io etc).
// A README badge has to render forever without anyone doing anything: an
// external badge host can go away, rate-limit, or drop support, and the badge
// would then just break silently on GitHub. Generating the SVG ourselves means
// the only dependency is this deployment being up, which the app already
// promises for everything else.
//
// Pure — no I/O, unit-tested without a server.

/** Rough Verdana-11px advance width; good enough for a badge, not typesetting. */
const CHAR_WIDTH = 6.5
const H_PADDING = 10
const HEIGHT = 20

export interface BadgeOptions {
  /** Left (label) segment background. */
  labelColor?: string
  /** Right (value) segment background. */
  color?: string
}

function segmentWidth(text: string): number {
  return Math.round(text.length * CHAR_WIDTH + H_PADDING * 2)
}

/** shields.io-style flat badge: dark label segment, colored value segment. */
export function renderBadge(
  label: string,
  message: string,
  { labelColor = '#555', color = '#4c1' }: BadgeOptions = {}
): string {
  const labelWidth = segmentWidth(label)
  const messageWidth = segmentWidth(message)
  const width = labelWidth + messageWidth
  const labelX = labelWidth / 2
  const messageX = labelWidth + messageWidth / 2

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="${esc(label)}: ${esc(message)}">
  <title>${esc(label)}: ${esc(message)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${width}" height="${HEIGHT}" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${HEIGHT}" fill="${labelColor}"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="${HEIGHT}" fill="${color}"/>
    <rect width="${width}" height="${HEIGHT}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelX}" y="14" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${labelX}" y="13">${esc(label)}</text>
    <text x="${messageX}" y="14" fill="#010101" fill-opacity=".3">${esc(message)}</text>
    <text x="${messageX}" y="13">${esc(message)}</text>
  </g>
</svg>`
}

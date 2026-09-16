import type { Metadata } from 'next'
import KonamiGame from '@/components/KonamiGame'
import SubwaySurfers from '@/components/SubwaySurfers'
import { publicUrl } from '@/lib/config'
import './globals.css'

// The absolute origin is required for the og:image URL (crawlers reject
// relative image paths and many ignore ones without a host). publicUrl is read
// from app.env at runtime, so this resolves for every deployment. When unset
// (e.g. some preview environments), fall back to relative — the homepage still
// works, only the share card origin is ambiguous.
const origin = publicUrl || undefined

export const metadata: Metadata = {
  title: 'longlivethis',
  description: 'The web is dead, long live the web',
  // Share card: a dynamic image rendering the current treasury balance and
  // runway — the distribution panel for every link shared to the site. When
  // publicUrl is set, crawlers get an absolute URL into /api/og, which
  // generates the card with the latest numbers on each scrape.
  ...(origin
    ? {
        metadataBase: new URL(origin),
        openGraph: {
          title: 'longlivethis',
          description: 'The web is dead, long live the web',
          images: [{ url: '/api/og', width: 1200, height: 630, alt: 'longlivethis — treasury & runway' }],
        },
        twitter: {
          card: 'summary_large_image',
          title: 'longlivethis',
          description: 'The web is dead, long live the web',
          images: ['/api/og'],
        },
      }
    : {}),
  icons: {
    icon: [
      { url: '/logo.png', type: 'image/png' },
      { url: '/logo.svg', type: 'image/svg+xml' },
    ],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-bg text-fg font-mono">
        {children}
        <SubwaySurfers />
        <KonamiGame />
      </body>
    </html>
  )
}

import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'longlivethis',
  description: 'The web is dead, long live the web',
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
        <div className="rainbow-bar" aria-hidden="true" />
        {children}
      </body>
    </html>
  )
}

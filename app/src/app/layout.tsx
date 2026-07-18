import type { Metadata } from 'next'
import './globals.css'
import EasterEgg from '@/components/EasterEgg'

export const metadata: Metadata = {
  title: 'longlivethis',
  description: 'The web is dead, long live the web',
  icons: { icon: '/logo.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-bg text-fg font-mono">{children}<EasterEgg /></body>
    </html>
  )
}

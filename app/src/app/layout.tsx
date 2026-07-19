import type { Metadata } from 'next'
import './globals.css'
import EasterEgg from '@/components/EasterEgg'
import ThemeProvider from '@/components/ThemeProvider'

export const metadata: Metadata = {
  title: 'longlivethis',
  description: 'The web is dead, long live the web',
  icons: { icon: '/logo.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen flex flex-col bg-bg text-fg font-mono">
        <ThemeProvider>
          {children}
          <EasterEgg />
        </ThemeProvider>
      </body>
    </html>
  )
}

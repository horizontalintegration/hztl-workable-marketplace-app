import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Workable Marketplace App',
  description: 'Sitecore Marketplace app for force-syncing Workable-backed content items',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

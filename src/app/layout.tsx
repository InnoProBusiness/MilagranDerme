import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Milagran Derme',
  description: 'Kit de limpeza de pele instantânea.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}

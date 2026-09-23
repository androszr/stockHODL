import type { Metadata } from 'next';

export const metadata: Metadata = {
  // Financial data behind a login has no business in a search index.
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

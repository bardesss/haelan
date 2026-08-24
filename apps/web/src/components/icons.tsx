// Inline so nothing is fetched at runtime; currentColor lets the active state recolour icons without a second token.
const PATHS: Record<string, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  activity: <path d="M4 19v-6M9.3 19V6M14.7 19v-9M20 19v-4" />,
  sleep: <path d="M20.5 14.8A8.5 8.5 0 0 1 9.2 3.5a8.5 8.5 0 1 0 11.3 11.3Z" />,
  recovery: <path d="M13 3 5.5 13.6h5.6L10 21l7.5-10.6h-5.6L13 3Z" />,
  health: (
    <>
      <path d="M12 20.3S4.8 15.6 4.8 10.8A3.9 3.9 0 0 1 12 8.6a3.9 3.9 0 0 1 7.2 2.2c0 4.8-7.2 9.5-7.2 9.5Z" />
      <path d="M4.8 13h3.5l1.4-2.4 1.8 4 1.4-2.6h6.3" />
    </>
  ),
  weight: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 12 15.6 8.4" />
    </>
  ),
  nutrition: (
    <>
      <path d="M12 8.4c-2.9 0-4.9 2.2-4.9 5.6 0 3.4 2.2 6.4 4.9 6.4s4.9-3 4.9-6.4c0-3.4-2-5.6-4.9-5.6Z" />
      <path d="M12 8.4V5.2M12 5.2c2 0 3.1-1 3.1-2.2" />
    </>
  ),
  notes: (
    <>
      <rect x="5" y="3.2" width="14" height="17.6" rx="2.2" />
      <path d="M9 8.4h6M9 12h6M9 15.6h4" />
    </>
  ),
  signOut: (
    <>
      <path d="M9 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H9" />
      <path d="M15 16l4-4-4-4M19 12H9" />
    </>
  ),
  sources: (
    <>
      <path d="M12 3 3.5 7.5 12 12l8.5-4.5L12 3Z" />
      <path d="M3.5 16.5 12 21l8.5-4.5M3.5 12 12 16.5 20.5 12" />
    </>
  ),
  download: <path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4 17.5v1.5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-1.5" />,
  sync: (
    <>
      <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9M3.5 12a8.5 8.5 0 0 1 14.6-5.9" />
      <path d="M18.1 2.5v3.6h-3.6M5.9 21.5v-3.6h3.6" />
    </>
  ),
  chevronLeft: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  chevronRight: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
}

export function Icon({ name }: { name: string }) {
  const path = PATHS[name]
  if (!path) return null
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  )
}

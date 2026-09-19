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
  // A trophy, for the page of all-time bests. Placed in rail order rather than alphabetically,
  // like every entry here: between dashboard and activity, because that is where Sidebar's own
  // GROUPS puts /records.
  records: (
    <>
      <path d="M8 4h8v5.5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5.5H5.6a2.4 2.4 0 0 0 0 4.8H8" />
      <path d="M16 5.5h2.4a2.4 2.4 0 0 1 0 4.8H16" />
      <path d="M12 13.5V17M9 20h6" />
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
  chevronDown: <path d="M5.5 9.5 12 16l6.5-6.5" />,
  // A person, for the reader's own account. Before settings in this file because that is where
  // the rail puts it: every entry here is in rail order rather than alphabetical.
  account: (
    <>
      <circle cx="12" cy="7.8" r="3.6" />
      <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M18 6l-1.7 1.7M7.7 16.3 6 18M18 18l-1.7-1.7M7.7 7.7 6 6" />
    </>
  ),
  docs: (
    <>
      <path d="M6 4h9.5L19 7.5V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M14.5 4v3.5H19M8.5 12h7M8.5 15.5h7" />
    </>
  ),
  changelog: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l3 2" />
      <path d="M8.5 3.5 5 6M15.5 3.5 19 6" />
    </>
  ),
  issues: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.3h.01" strokeWidth="2.6" />
    </>
  ),
  // One per exercise category (data/exerciseCategory.ts), drawn at the same 1.7 stroke and 24x24
  // box as everything above so a session row reads as part of this app rather than as clip art.
  // `sessionOther` is the fallback and is deliberately a real mark: every row carries a glyph, so
  // none of them is the row that looks unfinished.
  sessionRun: (
    <>
      <circle cx="13.6" cy="4.3" r="1.7" />
      <path d="M6.6 12.2 9.4 8.4l3.4-1.2 2.8 2.7 3 .9" />
      <path d="M9.2 21.4l2.5-5.2 2.9 2.2.9 3.1" />
      <path d="M11.7 16.2 9.9 12.6" />
    </>
  ),
  sessionWalk: (
    <>
      <circle cx="13.2" cy="4.1" r="1.7" />
      <path d="M10.6 21.6l1.7-5.8-2.1-2.2 1.1-5.3 3.5 2.1 2.1 2.7" />
      <path d="m12.3 15.8-3 2.4" />
    </>
  ),
  sessionRide: (
    <>
      <circle cx="5.6" cy="17.3" r="3.4" />
      <circle cx="18.4" cy="17.3" r="3.4" />
      <path d="M8.7 17.3h3.5l3.2-6.6h-4" />
      <path d="M14.4 4.6h2.5l1.5 12.7" />
    </>
  ),
  sessionSwim: (
    <>
      <path d="M3 17.7c1.8 0 1.8 1.4 3.5 1.4s1.8-1.4 3.5-1.4 1.8 1.4 3.5 1.4 1.8-1.4 3.5-1.4 1.8 1.4 3.5 1.4" />
      <path d="M6.6 14.1 12 11l4.4 2.6" />
      <circle cx="17.1" cy="7.4" r="1.7" />
    </>
  ),
  sessionStrength: <path d="M3.5 9.5v5M6.8 7.5v9M17.2 7.5v9M20.5 9.5v5M6.8 12h10.4" />,
  sessionCardio: (
    <path d="M12 20.3S4.8 15.6 4.8 10.8A3.9 3.9 0 0 1 12 8.6a3.9 3.9 0 0 1 7.2 2.2c0 4.8-7.2 9.5-7.2 9.5Z" />
  ),
  sessionOther: <path d="M4 19v-6M9.3 19V6M14.7 19v-9M20 19v-4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
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

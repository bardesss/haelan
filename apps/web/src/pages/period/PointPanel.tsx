import { useEffect, useRef } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Link } from '../../router.js'

/**
 * The small panel a tapped strip point opens on an overview page (PATTERNS.md's "Overview pages"):
 * that point's key figures, a way to its own page where it has one, and the day-metric exclude and
 * annotate, which the page then opens as an AnnotatePanel. Anchored under the strip by its caller
 * and non-modal: the page stays live around it, and Escape or a press anywhere outside closes it,
 * GlanceCalendar's popover rule. Escape is claimed, so a layer beneath does not close with it.
 *
 * The rows are the caller's, so a week's point (which reads only that week's hero value, and has
 * no page of its own) is one row and no link.
 */
export function PointPanel({ title, rows, open, onAnnotate, onClose }: {
  title: string
  rows: { label: string, value: string }[]
  open: { to: string, text: string } | null
  onAnnotate: (() => void) | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  // A ref, so a caller's fresh arrow every render does not re-register the listeners.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An Escape a layer above already claimed is not this panel's (LogButton's rule).
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && panel.current?.contains(target) === true) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [])

  return (
    <div ref={panel} className="point-panel" role="dialog" aria-label={title}>
      <p className="point-panel-title">{title}</p>
      {rows.length > 0 && (
        <dl className="point-panel-rows">
          {rows.map((row) => (
            <div key={row.label} className="point-panel-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(open !== null || onAnnotate !== null) && (
        <div className="point-panel-actions">
          {open !== null && <Link to={open.to} className="card-link">{open.text}</Link>}
          {onAnnotate !== null && <button type="button" className="button" onClick={onAnnotate}>{t('common.annotate')}</button>}
        </div>
      )}
    </div>
  )
}

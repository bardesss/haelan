export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <p className="empty">{title}<br /><small>{detail}</small></p>
}

export function DiffBadge({ added, removed }: { added: number; removed: number }) {
  return <span className="diff-badge" aria-label={`${added} lines added, ${removed} removed`}>
    <span className="diff-add">+{added}</span>
    <span className="diff-del">−{removed}</span>
  </span>;
}

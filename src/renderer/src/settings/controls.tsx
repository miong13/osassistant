export function Switch(props: { checked: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <label className="switch" title={props.label}>
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span />
    </label>
  )
}

export function Row(props: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="label">
        {props.label}
        {props.hint && <small>{props.hint}</small>}
      </div>
      {props.children}
    </div>
  )
}

export function StatusText({ status }: { status: { ok: boolean; message: string } | null }) {
  if (!status) return null
  return <span className={status.ok ? 'ok-text' : 'error-text'}>{status.message}</span>
}

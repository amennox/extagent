interface StatusDotProps {
  status?: 'idle' | 'running' | 'error' | 'detached' | 'rec';
  size?: number;
  label?: string;
}

const map: Record<string, { fill: string; pulse: boolean }> = {
  running:  { fill: 'var(--success)', pulse: true },
  idle:     { fill: 'var(--success)', pulse: false },
  error:    { fill: 'var(--error)',   pulse: false },
  detached: { fill: 'var(--text-subtle)', pulse: false },
  rec:      { fill: 'var(--error)',   pulse: true },
};

export function StatusDot({ status = 'idle', size = 8, label }: StatusDotProps) {
  const cfg = map[status] ?? map.idle;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        className={cfg.pulse ? 'ia-dot-pulse' : ''}
        style={{
          width: size, height: size, borderRadius: 999,
          background: cfg.fill, color: cfg.fill,
          flex: '0 0 auto',
        }}
      />
      {label && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>}
    </span>
  );
}

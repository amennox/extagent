import React from 'react';

export function SystemPill({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
      <span style={{
        fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
        background: 'var(--surface)', padding: '6px 12px', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)', fontWeight: 500, lineHeight: 1.35, maxWidth: '92%',
      }}>{children}</span>
    </div>
  );
}

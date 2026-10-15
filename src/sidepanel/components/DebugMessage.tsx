import React, { useState } from 'react';

interface DebugMessageProps {
  label?: string;
  content: string;
}

/**
 * Debug-mode trace block: distinct, subdued, collapsible monospace panel.
 * Shown only when debug mode is enabled (the background emits these messages
 * only in that case), so it never clutters normal use.
 */
export const DebugMessage: React.FC<DebugMessageProps> = ({ label, content }) => {
  // Raw responses can be long → collapsed by default, one click to expand.
  const [open, setOpen] = useState(false);
  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div
      data-testid="debug-message"
      style={{
        border: '1px dashed var(--border)',
        borderLeft: '2px solid var(--primary)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-2)',
        overflow: 'hidden',
        margin: '2px 0',
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 9px', border: 0, background: 'transparent', cursor: 'pointer',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)',
        }}
      >
        <span style={{
          fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
          color: 'var(--primary)', background: 'var(--primary-soft)',
          padding: '1px 5px', borderRadius: 4, flex: '0 0 auto',
        }}>debug</span>
        <span style={{ flex: 1, textAlign: 'left', color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label ?? 'trace'}
        </span>
        <span style={{ flex: '0 0 auto' }}>{lineCount} {open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <pre
          style={{
            margin: 0, padding: '8px 10px', borderTop: '1px solid var(--border)',
            background: 'var(--code-bg)', color: 'var(--code-fg)',
            fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 280, overflow: 'auto',
          }}
        >{content}</pre>
      )}
    </div>
  );
};

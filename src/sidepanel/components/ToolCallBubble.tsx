import React, { useState } from 'react';
import { useLang } from '../../i18n';
import { LucideIcon } from '../../ui';

interface ToolCallBubbleProps {
  tool: string;
  args: string;
  result?: string;
}

export function ToolCallBubble({ tool, args, result }: ToolCallBubbleProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: '9px 11px', maxWidth: '96%',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'transparent', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 20, height: 20, borderRadius: 5, background: 'var(--surface-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)',
          }}>
            <LucideIcon name="Wrench" size={11} />
          </div>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
            color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 0.4,
          }}>
            {tool}
          </span>
          <span style={{
            width: 6, height: 6, borderRadius: 999, background: 'var(--success)', flexShrink: 0,
          }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>{t('tool.call')}</span>
          <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s', display: 'inline-flex' }}>
            <LucideIcon name="ChevronDown" size={14} />
          </span>
        </div>
      </button>

      {open && (
        <div className="ia-expand-in" style={{
          marginTop: 10, padding: 10, background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11,
          color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-all',
        }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>{t('tool.input')}</div>
          {args}
          {result && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>→ </span>
              <span style={{ color: 'var(--success)' }}>{result}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

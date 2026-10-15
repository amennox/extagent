import React from 'react';
import { StatusDot, IconButton, LucideIcon } from '../../ui';

interface SPHeaderProps {
  tabName: string;
  tabStatus: string;
  onRefresh: () => void;
  onTabClick?: () => void;
}

export function SPHeader({ tabName, tabStatus, onRefresh }: SPHeaderProps) {
  const status = (['running', 'idle', 'error', 'detached', 'rec'].includes(tabStatus)
    ? tabStatus
    : 'idle') as 'running' | 'idle' | 'error' | 'detached' | 'rec';

  return (
    <div style={{
      height: 52, padding: '0 14px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', flex: '0 0 auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Logo />
        <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: -0.3, color: 'var(--text)' }}>DomMotion</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 999, height: 28, maxWidth: 220,
        }}>
          <StatusDot status={status} size={7} />
          <span style={{
            fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140,
          }}>{tabName || 'no tab'}</span>
          <button
            title="Refresh tab"
            onClick={onRefresh}
            style={{
              background: 'transparent', border: 0, padding: 2, marginLeft: 2, cursor: 'pointer',
              color: 'var(--text-muted)', display: 'inline-flex', borderRadius: 4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <LucideIcon name="RefreshCw" size={11.5} />
          </button>
        </div>
        <IconButton icon="X" size="sm" title="Close" onClick={() => window.close()} />
      </div>
    </div>
  );
}

function Logo() {
  return (
    <div style={{
      width: 24, height: 24, borderRadius: 7,
      background: 'linear-gradient(135deg, var(--primary), var(--primary-dim))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 2px 6px oklch(56% 0.19 296 / 0.25)',
    }}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 6L4.5 9.4641V2.5359L10 6Z" fill="white" />
      </svg>
    </div>
  );
}

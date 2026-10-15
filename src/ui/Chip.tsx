import React from 'react';
import { LucideIcon } from './LucideIcon';

export interface ChipProps {
  children?: React.ReactNode;
  tone?: 'neutral' | 'primary' | 'primarySolid' | 'success' | 'warning' | 'error';
  size?: 'sm' | 'xs';
  icon?: string;
  onClick?: () => void;
  dot?: boolean;
}

const tones: Record<string, { bg: string; fg: string; bd: string }> = {
  neutral:      { bg: 'var(--surface-2)', fg: 'var(--text-muted)', bd: 'var(--border)' },
  primary:      { bg: 'var(--primary-soft)', fg: 'var(--primary)', bd: 'transparent' },
  primarySolid: { bg: 'var(--primary)', fg: 'var(--primary-fg)', bd: 'transparent' },
  success:      { bg: 'var(--success-soft)', fg: 'var(--success)', bd: 'transparent' },
  warning:      { bg: 'var(--warning-soft)', fg: 'var(--warning-fg)', bd: 'transparent' },
  error:        { bg: 'var(--error-soft)',   fg: 'var(--error)',   bd: 'transparent' },
};

export function Chip({ children, tone = 'neutral', size = 'sm', icon, onClick, dot }: ChipProps) {
  const t = tones[tone] ?? tones.neutral;
  const sizing: React.CSSProperties = size === 'xs'
    ? { height: 18, padding: '0 7px', fontSize: 10, gap: 4 }
    : { height: 24, padding: '0 10px', fontSize: 11.5, gap: 5 };

  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
        borderRadius: 999, fontWeight: 600, lineHeight: 1,
        cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap',
        ...sizing,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: t.fg, flexShrink: 0 }} />}
      {icon && <LucideIcon name={icon} size={size === 'xs' ? 10 : 12} strokeWidth={1.75} />}
      {children}
    </span>
  );
}

import React from 'react';
import { LucideIcon } from './LucideIcon';

export interface IconButtonProps {
  icon?: string;
  onClick?: () => void;
  title?: string;
  variant?: 'ghost' | 'outline' | 'primary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  children?: React.ReactNode;
  'data-testid'?: string;
}

export function IconButton({
  icon, onClick, title, variant = 'ghost', size = 'md',
  active, disabled, danger, children, 'data-testid': testId,
}: IconButtonProps) {
  const sizeMap = { sm: 22, md: 28, lg: 34 };
  const iconSize = { sm: 12, md: 15, lg: 17 }[size];
  const dim = sizeMap[size];

  const isDanger = danger || variant === 'danger';

  const base: React.CSSProperties = {
    width: dim, height: dim, borderRadius: 8,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid transparent', cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1, transition: 'background .12s, border-color .12s, color .12s',
    color: 'var(--text-muted)', flex: '0 0 auto', padding: 0, background: 'transparent',
  };

  if (variant === 'outline') {
    base.background = 'var(--surface)';
    base.borderColor = 'var(--border)';
    base.color = 'var(--text)';
  } else if (variant === 'primary') {
    base.background = 'var(--primary)';
    base.color = 'var(--primary-fg)';
  } else if (isDanger) {
    base.color = 'var(--error)';
  }

  if (active) {
    base.background = 'var(--primary-soft)';
    base.color = 'var(--primary)';
    base.borderColor = 'transparent';
  }

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      title={title}
      aria-label={title}
      style={base}
      onMouseEnter={(e) => {
        if (disabled) return;
        const btn = e.currentTarget;
        if (variant === 'ghost' && !active) {
          btn.style.background = 'var(--surface-2)';
          btn.style.color = 'var(--text)';
        } else if (variant === 'outline') {
          btn.style.borderColor = 'var(--border-strong)';
        }
      }}
      onMouseLeave={(e) => {
        const btn = e.currentTarget;
        if (variant === 'ghost' && !active) {
          btn.style.background = 'transparent';
          btn.style.color = 'var(--text-muted)';
        } else if (variant === 'outline') {
          btn.style.borderColor = 'var(--border)';
        }
      }}
    >
      {icon ? <LucideIcon name={icon} size={iconSize} color={isDanger ? 'var(--error)' : undefined} /> : children}
    </button>
  );
}

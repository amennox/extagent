import React from 'react';
import { LucideIcon } from './LucideIcon';

export interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  iconRight?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  danger?: boolean;
  type?: 'button' | 'submit' | 'reset';
  'data-testid'?: string;
}

export function Button({
  children, onClick, variant = 'primary', size = 'md',
  icon, iconRight, disabled, fullWidth, danger, type = 'button',
  'data-testid': testId,
}: ButtonProps) {
  const sizes = {
    sm: { h: 28, px: 12, fs: 12, radius: 8 },
    md: { h: 36, px: 16, fs: 13, radius: 10 },
    lg: { h: 42, px: 20, fs: 14, radius: 12 },
  }[size];

  const isDanger = danger || variant === 'danger';

  const style: React.CSSProperties = {
    height: sizes.h,
    padding: `0 ${sizes.px}px`,
    fontSize: sizes.fs,
    borderRadius: sizes.radius,
    fontWeight: 600,
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: fullWidth ? '100%' : 'auto',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'background .12s, border-color .12s, color .12s, transform .06s',
    border: '1px solid transparent',
  };

  if (isDanger) {
    style.background = 'var(--error)';
    style.color = '#fff';
    style.borderColor = 'var(--error)';
  } else if (variant === 'primary') {
    style.background = 'var(--primary)';
    style.color = 'var(--primary-fg)';
    style.borderColor = 'var(--primary)';
  } else if (variant === 'outline') {
    style.background = 'transparent';
    style.color = 'var(--text)';
    style.borderColor = 'var(--border-strong)';
  } else if (variant === 'ghost') {
    style.background = 'transparent';
    style.color = 'var(--text-muted)';
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={style}
      onMouseEnter={(e) => {
        if (disabled) return;
        const btn = e.currentTarget;
        if (variant === 'outline') {
          btn.style.background = 'var(--surface-2)';
        } else if (variant === 'ghost') {
          btn.style.color = 'var(--text)';
          btn.style.background = 'var(--surface-2)';
        }
      }}
      onMouseLeave={(e) => {
        const btn = e.currentTarget;
        if (variant === 'outline') {
          btn.style.background = 'transparent';
        } else if (variant === 'ghost') {
          btn.style.color = 'var(--text-muted)';
          btn.style.background = 'transparent';
        }
      }}
    >
      {icon && <LucideIcon name={icon} size={sizes.fs + 1} />}
      {children}
      {iconRight && <LucideIcon name={iconRight} size={sizes.fs + 1} />}
    </button>
  );
}

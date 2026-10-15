import React from 'react';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: number | string;
  style?: React.CSSProperties;
}

export function Card({ children, className = '', padding, style }: CardProps) {
  return (
    <div
      className={`ia-card ${className}`}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

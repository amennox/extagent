import React from 'react';
import { useLang } from '../../i18n';
import { LucideIcon } from '../../ui';

interface LlmBubbleProps {
  children: React.ReactNode;
  streaming?: boolean;
}

export function LlmBubble({ children, streaming }: LlmBubbleProps) {
  const { t } = useLang();
  return (
    <div style={{
      alignSelf: 'flex-start',
      background: 'var(--surface-elevated)',
      border: '1px solid var(--border)',
      borderRadius: '10px 14px 14px 14px',
      padding: '10px 13px',
      maxWidth: '96%',
      boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div style={{
          width: 18, height: 18, borderRadius: 5, background: 'var(--primary-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)',
        }}>
          <LucideIcon name="Sparkles" size={11} />
        </div>
        <span style={{
          fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 0.5, textTransform: 'uppercase',
        }}>
          {t('sidepanel.assistant')}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text)' }}>
        {children}
        {streaming && <span className="ia-caret" />}
      </div>
    </div>
  );
}

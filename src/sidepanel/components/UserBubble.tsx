import React from 'react';
import { useLang } from '../../i18n';

export function UserBubble({ children }: { children: React.ReactNode }) {
  const { t } = useLang();
  return (
    <div style={{
      alignSelf: 'flex-end',
      background: 'var(--primary-soft)',
      borderRadius: '14px 14px 4px 14px',
      padding: '10px 13px',
      maxWidth: '92%',
    }}>
      <div style={{
        fontSize: 10, color: 'var(--primary)', marginBottom: 3,
        fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
      }}>
        {t('sidepanel.you')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, fontWeight: 500 }}>{children}</div>
    </div>
  );
}

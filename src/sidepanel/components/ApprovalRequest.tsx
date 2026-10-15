import React from 'react';
import { useLang } from '../../i18n';
import { Button } from '../../ui';
import { LucideIcon } from '../../ui';

interface ApprovalRequestProps {
  requestId: string;
  toolName: string;
  toolInput: string;
  reason: string;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
}

export function ApprovalRequest({
  requestId,
  toolName,
  toolInput,
  reason,
  onApprove,
  onReject,
}: ApprovalRequestProps) {
  const { t } = useLang();

  return (
    <div style={{
      margin: '0 14px 10px', flex: '0 0 auto',
      background: 'var(--warning-soft)', border: '1px solid var(--warning)',
      borderRadius: 'var(--radius-lg)', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 12px', background: 'var(--warning)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <LucideIcon name="ShieldAlert" size={15} color="var(--warning-fg)" />
        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--warning-fg)', letterSpacing: 0.2 }}>
          {t('approval.title')}
        </span>
      </div>
      <div style={{ padding: 12, display: 'grid', gridTemplateColumns: '64px 1fr', gap: '8px 10px', fontSize: 11.5 }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{t('approval.tool')}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{toolName}</span>

        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{t('approval.input')}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{toolInput}</span>

        {reason && (
          <>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{t('approval.reason')}</span>
            <span style={{ color: 'var(--text)' }}>{reason}</span>
          </>
        )}
      </div>
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--warning)', display: 'flex', gap: 8 }}>
        <Button variant="outline" fullWidth onClick={() => onReject(requestId)}>
          {t('approval.deny')}
        </Button>
        <Button fullWidth onClick={() => onApprove(requestId)}>
          {t('approval.approve')}
        </Button>
      </div>
    </div>
  );
}

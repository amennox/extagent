import React from 'react';
import { useLang } from '../../i18n';
import { LucideIcon } from '../../ui';
import { TaskEntry } from '../hooks/useTaskHistory';

interface TaskHistoryProps {
  history: TaskEntry[];
  onRerun: (prompt: string) => void;
}

export function TaskHistory({ history, onRerun }: TaskHistoryProps) {
  const { t } = useLang();

  if (history.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: '32px 12px', color: 'var(--text-muted)', textAlign: 'center',
      }}>
        <LucideIcon name="History" size={28} />
        <div style={{ fontSize: 12.5 }}>{t('history.empty')}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="task-history">
      {[...history].reverse().map((entry) => (
        <div
          key={entry.id}
          data-testid={`history-item-${entry.id}`}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            padding: '9px 11px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface)', border: '1px solid var(--border)',
            transition: 'background .12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
        >
          <span style={{
            fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontWeight: 500,
          }}>
            {entry.prompt.length > 60 ? entry.prompt.slice(0, 60) + '…' : entry.prompt}
          </span>
          <button
            title={t('history.rerun')}
            onClick={() => onRerun(entry.prompt)}
            data-testid={`btn-rerun-${entry.id}`}
            style={{
              background: 'transparent', border: 0, padding: 4, cursor: 'pointer',
              color: 'var(--text-muted)', display: 'inline-flex', borderRadius: 6, flex: '0 0 auto',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--primary)'; e.currentTarget.style.background = 'var(--primary-soft)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
          >
            <LucideIcon name="RotateCcw" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

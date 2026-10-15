import React, { useState } from 'react';
import { useLang } from '../../i18n';

interface FeedbackChipsProps {
  tabId: number | null;
  windowId?: number | null;
  onDone?: () => void;
}

/**
 * Zero-friction outcome feedback after a task: two inline chips.
 * 👍 validates the memories used in the task, 👎 removes/weakens them.
 */
export const FeedbackChips: React.FC<FeedbackChipsProps> = ({ tabId, windowId, onDone }) => {
  const { t } = useLang();
  const [sent, setSent] = useState<null | 'up' | 'down'>(null);

  const send = (positive: boolean) => {
    setSent(positive ? 'up' : 'down');
    chrome.runtime.sendMessage(
      { action: 'taskFeedback', positive, tabId: tabId ?? undefined, windowId: windowId ?? undefined },
      () => void chrome.runtime.lastError
    );
    setTimeout(() => onDone?.(), 1200);
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 10px',
    borderRadius: 999, border: '1px solid var(--border)', cursor: sent ? 'default' : 'pointer',
    background: active ? 'var(--primary-soft)' : 'var(--surface)',
    color: 'var(--text)', fontSize: 11, fontFamily: 'inherit',
    opacity: sent && !active ? 0.4 : 1, transition: 'all .12s',
  });

  return (
    <div data-testid="feedback-chips" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px 0' }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
        {sent ? t('feedback.thanks') : t('feedback.question')}
      </span>
      {!sent && (
        <>
          <button style={chipStyle(false)} onClick={() => send(true)} data-testid="feedback-up" title={t('feedback.good')}>
            👍
          </button>
          <button style={chipStyle(false)} onClick={() => send(false)} data-testid="feedback-down" title={t('feedback.bad')}>
            👎
          </button>
        </>
      )}
    </div>
  );
};

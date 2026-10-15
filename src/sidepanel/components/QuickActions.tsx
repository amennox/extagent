import React, { useState } from 'react';
import { useLang } from '../../i18n';
import { useQuickActions } from '../hooks/useQuickActions';
import { RecordingPanel } from './RecordingPanel';
import { SmartExtractPanel } from './SmartExtractPanel';
import { SmartPastePanel } from './SmartPastePanel';

interface QuickActionsProps {
  executePrompt: (prompt: string) => Promise<void>;
  isProcessing: boolean;
  /** Run a just-recorded procedure (opens its params form) */
  onRunProcedure?: (procedure: import('../../procedures/types').Procedure) => void;
}

type OpenPanel = 'smartPaste' | 'smartExtract' | 'recording' | null;

export const QuickActions: React.FC<QuickActionsProps> = ({ executePrompt, isProcessing, onRunProcedure }) => {
  const { t } = useLang();
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const { startSmartPaste, startSmartExtract } = useQuickActions({ executePrompt });

  const toggle = (panel: Exclude<OpenPanel, null>) =>
    setOpenPanel(prev => (prev === panel ? null : panel));

  const items = [
    { id: 'smartPaste' as const, label: t('quickactions.smartPaste') },
    { id: 'smartExtract' as const, label: t('quickactions.smartExtract') },
    { id: 'recording' as const, label: t('quickactions.automate') },
  ];

  return (
    <div data-testid="quick-actions" style={{ flex: '0 0 auto' }}>
      {openPanel === 'recording' && (
        <RecordingPanel
          onClose={() => setOpenPanel(null)}
          onRun={onRunProcedure ? (p) => { setOpenPanel(null); onRunProcedure(p); } : undefined}
        />
      )}
      {openPanel === 'smartPaste' && (
        <SmartPastePanel
          onSubmit={async (text) => { await startSmartPaste(text); setOpenPanel(null); }}
          onClose={() => setOpenPanel(null)}
        />
      )}
      {openPanel === 'smartExtract' && (
        <SmartExtractPanel
          onExtract={async (hint, format, paginate) => { await startSmartExtract(hint, format, paginate); setOpenPanel(null); }}
          onClose={() => setOpenPanel(null)}
        />
      )}
      <div style={{
        display: 'flex', gap: 6, padding: '0 14px 10px',
      }}>
        {items.map((it) => {
          const on = openPanel === it.id;
          const isRec = it.id === 'recording' && on;
          const testId = it.id === 'smartPaste' ? 'btn-smart-paste' : it.id === 'smartExtract' ? 'btn-smart-extract' : 'btn-automate';
          return (
            <button
              key={it.id}
              data-testid={testId}
              onClick={() => toggle(it.id)}
              disabled={isProcessing}
              style={{
                flex: '1 1 0', height: 30, borderRadius: 999, padding: '0 8px', minWidth: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 11, fontWeight: 700, cursor: isProcessing ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', border: '1px solid',
                background: on ? 'var(--primary-soft)' : 'var(--surface)',
                borderColor: on ? 'transparent' : 'var(--border)',
                color: isRec ? 'var(--error)' : (on ? 'var(--primary)' : 'var(--text)'),
                transition: 'background .12s, border-color .12s',
                opacity: isProcessing ? 0.5 : 1,
              }}
            >
              {isRec
                ? <span className="ia-dot-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--error)', color: 'var(--error)', flexShrink: 0 }} />
                : <span style={{
                    width: 7, height: 7, borderRadius: 999,
                    background: on ? 'var(--primary)' : 'var(--text-subtle)',
                    flexShrink: 0,
                  }} />}
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

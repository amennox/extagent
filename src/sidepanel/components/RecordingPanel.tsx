import React, { useEffect, useState } from 'react';
import { useLang } from '../../i18n';
import type { Procedure } from '../../procedures/types';
import { Button } from '../../ui';

interface RecordingPanelProps {
  onClose: () => void;
  onRun?: (procedure: Procedure) => void;
}

type PanelState = 'idle' | 'recording' | 'saved';

/**
 * Record a procedure by demonstration: start, act on the page, stop.
 * The result is a procedure (steps with thumbnails) to review in the editor.
 */
export const RecordingPanel: React.FC<RecordingPanelProps> = ({ onClose, onRun }) => {
  const { t } = useLang();
  const [state, setState] = useState<PanelState>('idle');
  const [name, setName] = useState('');
  const [count, setCount] = useState(0);
  const [last, setLast] = useState('');
  const [saved, setSaved] = useState<Procedure | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // Restore an in-progress recording (panel reopened)
    chrome.runtime.sendMessage({ action: 'getRecordingStatus' }, (res) => {
      void chrome.runtime.lastError;
      if (res?.active) {
        setState('recording');
        setName(res.name ?? '');
        setCount(res.count ?? 0);
      }
    });
    const listener = (message: any) => {
      if (message.action === 'recordingStepAdded') {
        if (typeof message.count === 'number') setCount(message.count);
        if (message.description) setLast(String(message.description));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const start = () => {
    setError('');
    chrome.runtime.sendMessage({ action: 'startRecordingCapture', name: name.trim() }, (res) => {
      void chrome.runtime.lastError;
      if (!res?.success) {
        setError(res?.error ?? 'Error');
        return;
      }
      setName(res.name ?? name);
      setCount(1);
      setLast('');
      setState('recording');
    });
  };

  const stop = () => {
    chrome.runtime.sendMessage({ action: 'stopRecordingCapture' }, (res) => {
      void chrome.runtime.lastError;
      if (res?.procedure) {
        setSaved(res.procedure);
        setState('saved');
      } else {
        setError(res?.error ?? t('rec.nothing'));
        setState('idle');
      }
    });
  };

  const cancel = () => {
    chrome.runtime.sendMessage({ action: 'cancelRecording' }, () => void chrome.runtime.lastError);
    setState('idle');
    setCount(0);
  };

  const openEditor = (id: string) => {
    chrome.runtime.sendMessage({ action: 'openProcedureEditor', procedureId: id }, () => void chrome.runtime.lastError);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)',
    borderRadius: 6, outline: 'none', background: 'var(--surface)', color: 'var(--text)',
    fontFamily: 'inherit', boxSizing: 'border-box',
  };

  return (
    <div className="ia-expand-in" style={{ padding: '0 14px 8px' }} data-testid="recording-panel">
      <div className="ia-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state === 'idle' && (
          <>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{t('rec.title')}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>{t('rec.hint')}</span>
            <input
              style={inputStyle}
              placeholder={t('rec.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="recording-name-input"
            />
            {error && <span style={{ fontSize: 11, color: 'var(--error)' }}>{error}</span>}
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
              <Button size="sm" icon="Circle" variant="danger" fullWidth onClick={start} data-testid="btn-start-recording">
                {t('rec.start')}
              </Button>
            </div>
          </>
        )}

        {state === 'recording' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--error)' }}>
                <span className="ia-dot-pulse" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--error)', color: 'var(--error)' }} />
                REC · {name}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }} data-testid="recording-status">{t('rec.steps', { n: String(count) })}</span>
            </div>
            {last && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('rec.last')}: {last}
              </span>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" icon="Square" variant="outline" fullWidth onClick={stop} data-testid="btn-stop-recording">{t('rec.stop')}</Button>
              <Button size="sm" icon="X" variant="ghost" onClick={cancel}>{t('rec.cancel')}</Button>
            </div>
          </>
        )}

        {state === 'saved' && saved && (
          <>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)' }} data-testid="recording-saved">
              {t('rec.savedTitle', { name: saved.name })}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {t('rec.savedDesc', { n: String(saved.steps.length) })}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" icon="Pencil" fullWidth onClick={() => openEditor(saved.id)}>{t('proc.openEditor')}</Button>
              {onRun && <Button size="sm" icon="Play" variant="outline" onClick={() => onRun(saved)}>{t('proc.runNow')}</Button>}
              <Button size="sm" variant="ghost" onClick={() => { setSaved(null); setState('idle'); onClose(); }}>✕</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

import React, { useState, useEffect, useCallback } from 'react';
import { Recording } from '../../background/recordingManager';
import { useLang } from '../../i18n';
import { Button } from '../../ui';
import { SkillWizard } from './SkillWizard';

interface RecordingPanelProps {
  onClose: () => void;
}

type PanelState = 'idle' | 'recording' | 'saving' | 'wizard';

export const RecordingPanel: React.FC<RecordingPanelProps> = ({ onClose }) => {
  const { t } = useLang();
  const [panelState, setPanelState] = useState<PanelState>('idle');
  const [stepCount, setStepCount] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [wizardRecording, setWizardRecording] = useState<Recording | null>(null);
  const [toast, setToast] = useState('');

  const loadRecordings = useCallback(async () => {
    const result = await chrome.storage.local.get('recordings');
    const all = (result.recordings as Record<string, Recording>) ?? {};
    setRecordings(Object.values(all));
  }, []);

  useEffect(() => {
    loadRecordings();
    const listener = (message: any) => {
      if (message.action === 'recordingStepAdded') setStepCount(c => c + 1);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [loadRecordings]);

  const handleStart = () => {
    if (!name.trim()) return;
    setStepCount(0);
    chrome.runtime.sendMessage({ action: 'startRecordingCapture', name: name.trim() });
    setPanelState('recording');
  };

  const handleStop = () => {
    chrome.runtime.sendMessage({ action: 'stopRecordingCapture' });
    setPanelState('saving');
  };

  const handleSave = async () => {
    const response = await chrome.runtime.sendMessage({ action: 'saveRecording', description: description.trim() });
    setName(''); setDescription('');
    await loadRecordings();
    // Offer the skill wizard right after saving
    if (response?.recording) {
      setWizardRecording(response.recording as Recording);
      setPanelState('wizard');
    } else {
      setPanelState('idle');
    }
  };

  const handleCancel = () => {
    chrome.runtime.sendMessage({ action: 'cancelRecording' });
    setName(''); setDescription(''); setPanelState('idle');
  };

  const handleDelete = async (recName: string) => {
    await chrome.runtime.sendMessage({ action: 'deleteRecording', name: recName });
    await loadRecordings();
  };

  const handlePlay = (recName: string) => {
    chrome.runtime.sendMessage({ action: 'playRecording', name: recName });
    onClose();
  };

  const handleExport = (rec: Recording) => {
    const data = JSON.stringify(rec, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${rec.name.replace(/\s+/g, '-')}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const openWizard = (rec: Recording) => {
    setWizardRecording(rec);
    setPanelState('wizard');
  };

  const handleWizardCreated = async (skillTitle: string) => {
    setWizardRecording(null);
    setPanelState('idle');
    setToast(`${t('wizard.created')}: ${skillTitle}`);
    setTimeout(() => setToast(''), 4000);
    await loadRecordings();
  };

  if (panelState === 'wizard' && wizardRecording) {
    return (
      <div className="ia-expand-in" style={{ padding: '0 14px 8px' }} data-testid="recording-panel">
        <SkillWizard
          recording={wizardRecording}
          onClose={() => { setWizardRecording(null); setPanelState('idle'); }}
          onCreated={handleWizardCreated}
        />
      </div>
    );
  }

  return (
    <div className="ia-expand-in" style={{ padding: '0 14px 8px' }} data-testid="recording-panel">
      <div className="ia-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toast && (
          <div style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }} data-testid="wizard-toast">{toast}</div>
        )}

        {panelState === 'idle' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{t('recording.title')}</span>
            </div>
            <input
              className="ia-card-sm"
              placeholder={t('recording.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="recording-name-input"
              style={{
                width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)',
                borderRadius: 6, outline: 'none', background: 'var(--surface)', color: 'var(--text)',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
              <Button size="sm" icon="Circle" variant="danger" fullWidth onClick={handleStart} disabled={!name.trim()} data-testid="btn-start-recording">
                {t('recording.startRec')}
              </Button>
            </div>
          </>
        )}

        {panelState === 'recording' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--error)' }}>
                <span className="ia-dot-pulse" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--error)', color: 'var(--error)' }} />
                REC
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }} data-testid="recording-status">{stepCount} {t('recording.steps')}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" icon="Square" variant="outline" fullWidth onClick={handleStop} data-testid="btn-stop-recording">{t('recording.stopRec')}</Button>
              <Button size="sm" icon="X" variant="ghost" fullWidth onClick={handleCancel}>{t('recording.cancel')}</Button>
            </div>
          </>
        )}

        {panelState === 'saving' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="recording-save-form">
            <input
              placeholder={t('recording.descPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="recording-desc-input"
              style={{
                width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)',
                borderRadius: 6, outline: 'none', background: 'var(--surface)', color: 'var(--text)',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" icon="Save" fullWidth onClick={handleSave} data-testid="btn-save-recording">{t('recording.save')}</Button>
              <Button size="sm" variant="ghost" fullWidth onClick={handleCancel} data-testid="btn-cancel-recording">{t('recording.cancel')}</Button>
            </div>
          </div>
        )}

        {recordings.length > 0 && panelState !== 'recording' && (
          <div data-testid="recording-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {t('recording.saved')}
            </div>
            {recordings.map((rec) => (
              <div
                key={rec.name}
                className="ia-row-hover"
                data-testid={`recording-item-${rec.name}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                  borderRadius: 6, fontSize: 11.5,
                }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                  {rec.name} ({rec.steps.length})
                </span>
                <button title={t('recording.play')} onClick={() => handlePlay(rec.name)} data-testid={`btn-play-${rec.name}`} style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--primary)', padding: 2 }}>▶</button>
                <button title={t('recording.createSkill')} onClick={() => openWizard(rec)} data-testid={`btn-skill-${rec.name}`} style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--primary)', padding: 2 }}>✦</button>
                <button title={t('recording.export')} onClick={() => handleExport(rec)} data-testid={`btn-export-${rec.name}`} style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}>⬇</button>
                <button title={t('recording.delete')} onClick={() => handleDelete(rec.name)} data-testid={`btn-delete-${rec.name}`} style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--error)', padding: 2 }}>🗑</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

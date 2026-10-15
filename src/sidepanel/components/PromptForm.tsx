import React, { useState } from 'react';
import { useLang } from '../../i18n';
import { LucideIcon } from '../../ui';

interface PromptFormProps {
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
  isProcessing: boolean;
  tabStatus: 'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error';
}

export const PromptForm: React.FC<PromptFormProps> = ({
  onSubmit,
  onCancel,
  isProcessing,
  tabStatus,
}) => {
  const { t } = useLang();
  const [prompt, setPrompt] = useState('');
  const isDetached = tabStatus === 'detached';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isDetached) return;
    onSubmit(prompt);
    setPrompt('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  return (
    <div style={{ padding: '0 14px 14px', flex: '0 0 auto' }}>
      <form onSubmit={handleSubmit}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-card)', padding: 10,
        }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isDetached ? t('sidepanel.placeholderDisconnected') : t('sidepanel.placeholder')}
            autoFocus
            disabled={isDetached}
            rows={2}
            style={{
              width: '100%', minHeight: 38, maxHeight: 160, resize: 'none',
              border: 0, outline: 'none', fontFamily: 'inherit', fontSize: 13,
              color: 'var(--text)', background: 'transparent', padding: '4px 6px',
              lineHeight: 1.5, boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 10.5 }}>
              <span className="ia-kbd">↵</span><span>{t('composer.send')}</span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span className="ia-kbd">⇧↵</span><span>{t('composer.newline')}</span>
            </div>
            <button
              type={isProcessing ? 'button' : 'submit'}
              onClick={isProcessing ? onCancel : undefined}
              title={isProcessing ? t('action.stop') : t('action.send')}
              style={{
                width: 34, height: 34, borderRadius: 999, border: 0, cursor: 'pointer',
                background: isProcessing ? 'var(--accent)' : 'var(--primary)',
                color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background .15s, transform .15s',
                opacity: (!prompt.trim() && !isProcessing) ? 0.5 : 1,
              }}
            >
              <LucideIcon name={isProcessing ? 'Square' : 'SendHorizontal'} size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </form>
      <ProviderChipInline />
    </div>
  );
};

interface ChipInfo {
  profileName: string;
}

function ProviderChipInline() {
  const { t } = useLang();
  const [info, setInfo] = useState<ChipInfo | null>(null);

  const loadInfo = React.useCallback(() => {
    import('../../background/configManager').then(({ ConfigManager }) => {
      const cfg = ConfigManager.getInstance();
      cfg.getActiveProfile().then((profile) => {
        setInfo({ profileName: profile?.name || 'default' });
      }).catch(() => {});
    });
  }, []);

  React.useEffect(() => {
    loadInfo();
    const handler = () => loadInfo();
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [loadInfo]);

  if (!info) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 6 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 24,
        padding: '0 10px', borderRadius: 999, background: 'var(--surface)',
        border: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)', minWidth: 0, overflow: 'hidden',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--success)', flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--primary)', fontWeight: 700 }}>
          {info.profileName}
        </span>
        <span style={{ opacity: 0.6 }}>·</span>
        <span>{t('sidepanel.localModel')}</span>
      </span>
      <button
        onClick={() => chrome.runtime.openOptionsPage()}
        title={t('action.settings')}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 8, border: '1px solid var(--border)',
          background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
          flexShrink: 0, padding: 0,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
      >
        <LucideIcon name="Settings" size={13} />
      </button>
    </div>
  );
}

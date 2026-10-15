import React, { useState } from 'react';
import { useLang } from '../../i18n';
import { Button } from '../../ui';
import { LucideIcon } from '../../ui';

interface SmartExtractPanelProps {
  onExtract: (hint: string, format: string, paginate: boolean) => Promise<void>;
  onClose: () => void;
}

export const SmartExtractPanel: React.FC<SmartExtractPanelProps> = ({
  onExtract,
  onClose,
}) => {
  const { t } = useLang();
  const [format, setFormat] = useState('json');
  const [paginate, setPaginate] = useState(false);
  const [hint, setHint] = useState('');
  const [extracting, setExtracting] = useState(false);

  const handleExtract = async () => {
    setExtracting(true);
    try {
      await onExtract(hint, format, paginate);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="ia-expand-in" style={{ padding: '0 14px 8px' }}>
      <div className="ia-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LucideIcon name="ScanText" size={13} color="var(--primary)" /> {t('smartextract.title')}
          </span>
          <select
            data-testid="smart-extract-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            style={{
              height: 26, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit',
              outline: 'none',
            }}
          >
            <option value="json">{t('quickactions.format.json')}</option>
            <option value="csv">{t('quickactions.format.csv')}</option>
          </select>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={paginate}
            onChange={(e) => setPaginate(e.target.checked)}
            style={{ accentColor: 'var(--primary)' }}
            data-testid="smart-extract-paginate"
          />
          {t('quickactions.multipage')}
        </label>

        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'block' }}>
            {t('quickactions.hintLabel')}
          </label>
          <textarea
            data-testid="smart-extract-hint"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder={t('quickactions.hintPlaceholder')}
            rows={2}
            style={{
              width: '100%', padding: 8, borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12,
              resize: 'vertical', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="smart-extract-close">✕</Button>
          <Button size="sm" icon="ScanText" fullWidth onClick={handleExtract} disabled={extracting} data-testid="smart-extract-submit">
            {extracting ? '...' : `${t('quickactions.extractNow')} ${format.toUpperCase()}`}
          </Button>
        </div>
      </div>
    </div>
  );
};

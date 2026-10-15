import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../../i18n';
import { ProcedureStore } from '../../procedures/store';
import type { Procedure } from '../../procedures/types';
import { Button } from '../../ui';

interface ProcedureBarProps {
  tabId: number | null;
  isProcessing: boolean;
  /** Called when a run starts (switch UI to processing) */
  onRunStarted: (procedure: Procedure) => void;
  /** Procedure to open directly in the params form (e.g. just recorded) */
  requested?: Procedure | null;
  onRequestHandled?: () => void;
}

/**
 * Suggestions in the side panel: the procedures saved for the current site
 * as one-click chips (with a parameters form when needed).
 */
export const ProcedureBar: React.FC<ProcedureBarProps> = ({ tabId, isProcessing, onRunStarted, requested, onRequestHandled }) => {
  const { t } = useLang();
  const [forSite, setForSite] = useState<Procedure[]>([]);
  const [all, setAll] = useState<Procedure[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Procedure | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const store = ProcedureStore.getInstance();
    const list = await store.list().catch(() => []);
    setAll(list);
    let url = '';
    try { url = tabId ? (await chrome.tabs.get(tabId))?.url ?? '' : ''; } catch { url = ''; }
    setForSite(url ? await store.listForDomain(url).catch(() => []) : []);
  }, [tabId]);

  useEffect(() => {
    load();
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'procedures' in changes) load();
    };
    const onTab = () => load();
    chrome.storage.onChanged.addListener(onStorage);
    chrome.tabs.onUpdated?.addListener(onTab);
    chrome.tabs.onActivated?.addListener(onTab);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.tabs.onUpdated?.removeListener(onTab);
      chrome.tabs.onActivated?.removeListener(onTab);
    };
  }, [load]);

  const run = (proc: Procedure, params: Record<string, string>) => {
    setError('');
    onRunStarted(proc);
    chrome.runtime.sendMessage({ action: 'runProcedure', procedureId: proc.id, params, tabId: tabId ?? undefined }, (res) => {
      void chrome.runtime.lastError;
      if (res && res.success === false && res.error) setError(res.error);
    });
    setSelected(null);
  };

  const choose = (proc: Procedure) => {
    if (proc.params.length === 0) {
      run(proc, {});
      return;
    }
    const init: Record<string, string> = {};
    for (const p of proc.params) init[p.name] = p.type === 'secret' ? '' : (p.default ?? '');
    setValues(init);
    setSelected(proc);
  };

  useEffect(() => {
    if (requested) {
      choose(requested);
      onRequestHandled?.();
    }
  }, [requested]);

  const visible = showAll ? all : forSite;
  if (all.length === 0) return null;

  const missing = selected ? selected.params.filter(p => p.required && !(values[p.name] ?? '').trim()) : [];

  return (
    <div style={{ padding: '0 14px 8px', flex: '0 0 auto' }} data-testid="procedure-bar">
      {selected ? (
        <div className="ia-card ia-expand-in" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{selected.name}</span>
          {selected.params.map(p => (
            <label key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10.5, color: 'var(--text-muted)' }}>
              {p.label || p.name}{p.required ? ' *' : ''}
              {p.type === 'select' && p.options?.length ? (
                <select value={values[p.name] ?? ''} onChange={e => setValues(v => ({ ...v, [p.name]: e.target.value }))} style={fieldStyle}>
                  <option value="">—</option>
                  {p.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={p.type === 'secret' ? 'password' : p.type === 'number' ? 'number' : 'text'}
                  value={values[p.name] ?? ''}
                  placeholder={p.type === 'date' ? 'GG/MM/AAAA' : p.description ?? ''}
                  onChange={e => setValues(v => ({ ...v, [p.name]: e.target.value }))}
                  style={fieldStyle}
                  data-testid={`param-${p.name}`}
                />
              )}
            </label>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>{t('proc.cancel')}</Button>
            <Button size="sm" icon="Play" fullWidth disabled={missing.length > 0 || isProcessing} onClick={() => run(selected, values)} data-testid="btn-run-procedure">
              {t('proc.runNow')}
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {showAll ? t('proc.title') : t('proc.forThisSite')}
          </span>
          {visible.slice(0, 8).map(p => (
            <button
              key={p.id}
              title={p.description || p.name}
              disabled={isProcessing}
              onClick={() => choose(p)}
              data-testid={`procedure-chip-${p.id}`}
              style={{
                height: 24, padding: '0 10px', borderRadius: 999, border: '1px solid var(--border)',
                background: 'var(--surface)', color: 'var(--text)', fontSize: 11, cursor: isProcessing ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                opacity: isProcessing ? 0.5 : 1,
              }}
            >
              ▶ {p.name}
            </button>
          ))}
          {(all.length > forSite.length || showAll) && (
            <button
              onClick={() => setShowAll(s => !s)}
              style={{ border: 0, background: 'transparent', color: 'var(--primary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {showAll ? t('proc.forThisSite') : `${t('proc.all')} (${all.length})`}
            </button>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: 'var(--error)', marginTop: 4 }}>{error}</div>}
    </div>
  );
};

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6,
  outline: 'none', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
};

interface SaveTaskCardProps {
  tabId: number | null;
  windowId?: number | null;
  onDone: () => void;
}

/** After a successful task: save its actions as a procedure in one click. */
export const SaveTaskCard: React.FC<SaveTaskCardProps> = ({ tabId, windowId, onDone }) => {
  const { t } = useLang();
  const [saved, setSaved] = useState<Procedure | null>(null);
  const [error, setError] = useState('');

  const save = () => {
    chrome.runtime.sendMessage({ action: 'saveTaskAsProcedure', tabId: tabId ?? undefined, windowId: windowId ?? undefined }, (res) => {
      void chrome.runtime.lastError;
      if (res?.procedure) setSaved(res.procedure);
      else setError(res?.error ?? 'Error');
    });
  };

  return (
    <div className="ia-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="save-task-card">
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{saved ? t('proc.savedOpen') : t('proc.saveTaskHint')}</span>
      {error && <span style={{ fontSize: 11, color: 'var(--error)' }}>{error}</span>}
      <div style={{ display: 'flex', gap: 6 }}>
        {saved ? (
          <Button size="sm" icon="Pencil" onClick={() => {
            chrome.runtime.sendMessage({ action: 'openProcedureEditor', procedureId: saved.id }, () => void chrome.runtime.lastError);
            onDone();
          }}>{t('proc.openEditor')}</Button>
        ) : (
          <Button size="sm" icon="Save" onClick={save} data-testid="btn-save-task">{t('proc.saveTask')}</Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDone}>✕</Button>
      </div>
    </div>
  );
};

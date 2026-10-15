/// <reference types="chrome"/>
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../../../i18n';
import { makeParam, undeclaredParams } from '../../../procedures/builder';
import { migrateLegacyAutomations } from '../../../procedures/migration';
import { procedureToMarkdown, ProcedureStore } from '../../../procedures/store';
import {
  ApprovalSetting, newId, ParamType, Procedure, ProcedureParam, ProcedureStep, STEP_TYPES, StepType, TARGETED_STEPS,
} from '../../../procedures/types';
import { Button, Chip, EmptyState, IconButton, LucideIcon } from '../../../ui';
import { Section } from '../Section';

type T = (key: string, vars?: Record<string, string>) => string;

const VALUE_STEPS = new Set<StepType>(['navigate', 'fill', 'select', 'check', 'press', 'wait', 'scroll']);

function download(name: string, text: string, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'procedura';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 9px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6,
  outline: 'none', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4,
};

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}g`;
}

function outcomeTone(outcome?: string): 'success' | 'error' | 'warning' | 'neutral' {
  if (outcome === 'success') return 'success';
  if (outcome === 'failure') return 'error';
  if (outcome === 'needs_agent') return 'warning';
  return 'neutral';
}

// ── List ────────────────────────────────────────────────────────────────────

export function ProceduresTab() {
  const { t } = useLang();
  const [list, setList] = useState<Procedure[]>([]);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const store = ProcedureStore.getInstance();

  const load = useCallback(async () => {
    await migrateLegacyAutomations().catch(() => 0);
    setList(await store.list());
  }, [store]);

  useEffect(() => {
    load();
    const fromHash = () => {
      const m = window.location.hash.match(/^#procedures\/(.+)$/);
      if (m) setEditingId(decodeURIComponent(m[1]));
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'procedures' in changes) load();
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      window.removeEventListener('hashchange', fromHash);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, [load]);

  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(''), 3500);
  };

  const open = (id: string | null) => {
    setEditingId(id);
    window.location.hash = id ? `procedures/${encodeURIComponent(id)}` : 'procedures';
  };

  const createNew = async () => {
    const now = Date.now();
    const proc = await store.save({
      id: newId('p_'), name: t('proc.new'), description: '', params: [],
      steps: [{ id: newId('s_'), type: 'navigate', description: 'Apri la pagina iniziale', value: 'https://', approval: 'auto' }],
      version: 1, createdAt: now, updatedAt: now, source: 'manual', runs: [],
    });
    open(proc.id);
  };

  const onImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const imported = await store.importJson(String(ev.target?.result ?? ''));
        flash(`${imported.length} ✓`);
        load();
      } catch (err) {
        flash(`Errore: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(p => `${p.name} ${p.description} ${p.domain ?? ''}`.toLowerCase().includes(q));
  }, [list, query]);

  const editing = editingId ? list.find(p => p.id === editingId) : null;
  if (editingId && editing) {
    return <ProcedureEditor key={editing.id} initial={editing} t={t} onBack={() => open(null)} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} data-testid="procedures-tab">
      <Section
        title={t('proc.title')}
        description={t('proc.desc')}
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" icon="Plus" onClick={createNew}>{t('proc.new')}</Button>
            <Button size="sm" variant="outline" icon="Upload" onClick={() => importRef.current?.click()}>{t('proc.import')}</Button>
            <Button size="sm" variant="outline" icon="Download" disabled={!list.length}
              onClick={() => download(`procedure-${new Date().toISOString().slice(0, 10)}.json`, store.exportJson(list))}>
              {t('proc.exportAll')}
            </Button>
            <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onImport} />
          </div>
        }
      >
        {status && <div style={{ fontSize: 12, color: 'var(--success)' }}>{status}</div>}
        {list.length > 4 && (
          <input style={inputStyle} placeholder={t('proc.search')} value={query} onChange={e => setQuery(e.target.value)} />
        )}
        {filtered.length === 0 ? (
          <EmptyState icon="Workflow" title={t('proc.title')} description={t('proc.empty')} />
        ) : (
          <div className="ia-card" style={{ overflow: 'hidden' }}>
            {filtered.map((p, i) => {
              const last = p.runs?.[0];
              return (
                <div key={p.id} data-testid={`procedure-row-${p.id}`} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                  borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  {p.steps.find(s => s.thumbnail)?.thumbnail ? (
                    <img src={p.steps.find(s => s.thumbnail)!.thumbnail} alt="" style={{ width: 64, height: 40, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />
                  ) : (
                    <div style={{ width: 64, height: 40, borderRadius: 4, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                      <LucideIcon name="Workflow" size={16} />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => open(p.id)}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[p.domain, t('proc.stepsCount', { n: String(p.steps.length) }), p.params.length ? `${p.params.length} ${t('proc.params').toLowerCase()}` : '', t(`proc.source.${p.source}`)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {last && <Chip size="xs" tone={outcomeTone(last.outcome) as any}>{t(`proc.outcome.${last.outcome}`)} · {timeAgo(last.at)}</Chip>}
                  <div style={{ display: 'flex', gap: 2 }}>
                    <IconButton icon="Pencil" size="sm" title={t('skills.edit')} onClick={() => open(p.id)} />
                    <IconButton icon="Copy" size="sm" title={t('proc.duplicate')} onClick={async () => { await store.duplicate(p.id); load(); }} />
                    <IconButton icon="Download" size="sm" title={t('proc.export')} onClick={() => download(`${fileSafe(p.name)}.json`, store.exportJson([p]))} />
                    <IconButton icon="Trash2" size="sm" danger title={t('proc.delete')} onClick={async () => {
                      if (window.confirm(t('proc.deleteConfirm', { name: p.name }))) { await store.delete(p.id); load(); }
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

interface EditorProps {
  initial: Procedure;
  t: T;
  onBack: () => void;
}

function ProcedureEditor({ initial, t, onBack }: EditorProps) {
  const store = ProcedureStore.getInstance();
  const [draft, setDraft] = useState<Procedure>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState('');
  const [runValues, setRunValues] = useState<Record<string, string> | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    const listener = (msg: any) => {
      if (msg.action !== 'procedureProgress' || msg.content?.procedureId !== draft.id) return;
      const c = msg.content;
      if (c.status === 'finished') setProgress(`${t(`proc.outcome.${c.result === 'success' ? 'success' : c.result === 'needs_agent' ? 'needs_agent' : c.result === 'cancelled' ? 'cancelled' : 'failure'}`)}`);
      else if (c.status !== 'started') setProgress(`${c.index + 1}/${c.total} · ${c.status} · ${c.description ?? ''}${c.message ? ` — ${c.message}` : ''}`);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [draft.id, t]);

  const update = (patch: Partial<Procedure>) => {
    setDraft(d => ({ ...d, ...patch }));
    setDirty(true);
  };
  const updateStep = (i: number, patch: Partial<ProcedureStep>) => {
    setDraft(d => ({ ...d, steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
    setDirty(true);
  };
  const updateParam = (i: number, patch: Partial<ProcedureParam>) => {
    setDraft(d => ({ ...d, params: d.params.map((p, k) => (k === i ? { ...p, ...patch } : p)) }));
    setDirty(true);
  };

  const save = async (): Promise<Procedure> => {
    setSaving(true);
    try {
      const saved = await store.save(draft);
      setDraft(saved);
      setDirty(false);
      setMessage(t('proc.saved'));
      setTimeout(() => setMessage(''), 2500);
      return saved;
    } finally {
      setSaving(false);
    }
  };

  const run = async (opts: { startAt?: number; endAt?: number; mode?: 'direct' | 'test'; params?: Record<string, string> }) => {
    const saved = dirty ? await save() : draft;
    setProgress('…');
    chrome.runtime.sendMessage({ action: 'runProcedure', procedureId: saved.id, params: opts.params ?? {}, ...opts }, (res) => {
      void chrome.runtime.lastError;
      if (res && res.success === false) setProgress(`❌ ${res.error}`);
      store.get(saved.id).then(p => { if (p) setDraft(d => ({ ...d, runs: p.runs })); });
    });
  };

  const defaultsFor = (): Record<string, string> => {
    const v: Record<string, string> = {};
    for (const p of draft.params) v[p.name] = p.type === 'secret' ? '' : (p.default ?? '');
    return v;
  };

  const pendingRun = useRef<{ startAt?: number; endAt?: number; mode?: 'direct' | 'test' }>({});
  const startRun = (opts: { startAt?: number; endAt?: number; mode?: 'direct' | 'test' } = {}) => {
    const needsInput = draft.params.some(p => p.required && (p.type === 'secret' || !p.default));
    if (needsInput && !runValues) {
      setRunValues(defaultsFor());
      pendingRun.current = opts;
      return;
    }
    run({ ...opts, params: runValues ?? defaultsFor() });
  };

  const aiSuggest = async () => {
    const saved = dirty ? await save() : draft;
    setAiBusy(true);
    chrome.runtime.sendMessage({ action: 'analyzeProcedure', procedureId: saved.id }, (res) => {
      void chrome.runtime.lastError;
      setAiBusy(false);
      if (!res?.suggestion) {
        setMessage(`❌ ${res?.error ?? 'AI'}`);
        return;
      }
      let next = { ...saved };
      if (res.suggestion.name) next.name = res.suggestion.name;
      if (res.suggestion.description && !next.description) next.description = res.suggestion.description;
      for (const p of res.suggestion.params ?? []) {
        if (next.steps[p.stepIndex] && !/\{\{/.test(next.steps[p.stepIndex].value ?? '')) {
          next = makeParam(next, p.stepIndex, p.name);
          const idx = next.params.findIndex(x => x.name === p.name);
          if (idx >= 0 && p.label) next.params[idx] = { ...next.params[idx], label: p.label };
        }
      }
      setDraft(next);
      setDirty(true);
    });
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    update({ steps });
  };

  const insertStep = (at: number, type: StepType = 'ai') => {
    const step: ProcedureStep = {
      id: newId('s_'), type, approval: 'auto',
      description: type === 'ai' ? 'Passo eseguito dall\'agente' : type,
      instruction: type === 'ai' ? '' : undefined,
    };
    const steps = [...draft.steps];
    steps.splice(at, 0, step);
    update({ steps });
  };

  const undeclared = undeclaredParams(draft);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} data-testid="procedure-editor">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant="ghost" icon="ArrowLeft" onClick={() => {
          if (!dirty || window.confirm('Modifiche non salvate: uscire comunque?')) onBack();
        }}>{t('proc.back')}</Button>
        <div style={{ flex: 1 }} />
        {message && <span style={{ fontSize: 12, color: 'var(--success)' }}>{message}</span>}
        <Button size="sm" variant="outline" icon="Sparkles" disabled={aiBusy} onClick={aiSuggest}>
          {aiBusy ? t('proc.aiSuggesting') : t('proc.aiSuggest')}
        </Button>
        <Button size="sm" variant="outline" icon="FileText" onClick={() => download(`${fileSafe(draft.name)}.md`, procedureToMarkdown(draft), 'text/markdown')}>{t('proc.exportMd')}</Button>
        <Button size="sm" variant="outline" icon="Play" onClick={() => startRun({ mode: 'direct' })} data-testid="editor-run">{t('proc.run')}</Button>
        <Button size="sm" icon="Save" disabled={!dirty || saving} onClick={save} data-testid="editor-save">{t('proc.save')}</Button>
      </div>

      {runValues && (
        <div className="ia-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={labelStyle}>{t('proc.params')}</span>
          {draft.params.map(p => (
            <label key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 160 }}>{p.label || p.name}{p.required ? ' *' : ''}</span>
              <input style={inputStyle} type={p.type === 'secret' ? 'password' : 'text'} value={runValues[p.name] ?? ''}
                onChange={e => setRunValues(v => ({ ...(v ?? {}), [p.name]: e.target.value }))} />
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 'auto' }}>{t('proc.runHint')}</span>
            <Button size="sm" variant="ghost" onClick={() => setRunValues(null)}>{t('proc.cancel')}</Button>
            <Button size="sm" icon="Play" onClick={() => { const v = runValues; setRunValues(null); run({ ...pendingRun.current, params: v }); }}>{t('proc.run')}</Button>
          </div>
        </div>
      )}
      {progress && <div style={{ fontSize: 12, color: 'var(--text-muted)' }} data-testid="editor-progress">▶ {progress}</div>}

      <Section title={draft.name || t('proc.name')} description={t(`proc.source.${draft.source}`)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label={t('proc.name')}><input style={inputStyle} value={draft.name} onChange={e => update({ name: e.target.value })} data-testid="editor-name" /></Field>
          <Field label={t('proc.domain')}><input style={inputStyle} value={draft.domain ?? ''} onChange={e => update({ domain: e.target.value })} /></Field>
          <Field label={t('proc.description')} wide><input style={inputStyle} value={draft.description} onChange={e => update({ description: e.target.value })} /></Field>
          <Field label={t('proc.startUrl')} wide><input style={inputStyle} value={draft.startUrl ?? ''} onChange={e => update({ startUrl: e.target.value })} /></Field>
          <Field label={t('proc.notes')} wide>
            <textarea style={{ ...inputStyle, minHeight: 50, resize: 'vertical' }} value={draft.notes ?? ''} onChange={e => update({ notes: e.target.value })} />
          </Field>
        </div>
      </Section>

      <Section
        title={t('proc.params')}
        description={t('proc.paramsHint')}
        action={<Button size="sm" variant="outline" icon="Plus" onClick={() => update({ params: [...draft.params, { name: `param_${draft.params.length + 1}`, type: 'text', required: true }] })}>{t('proc.addParam')}</Button>}
      >
        {undeclared.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--warning-fg)' }}>⚠ {t('proc.undeclared', { names: undeclared.join(', ') })}</div>
        )}
        {draft.params.length > 0 && (
          <div className="ia-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {draft.params.map((p, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr 0.9fr 1.2fr auto auto', gap: 8, alignItems: 'center' }}>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} value={p.name} placeholder={t('proc.paramName')}
                  onChange={e => updateParam(i, { name: e.target.value.replace(/[^\w.-]/g, '_') })} />
                <input style={inputStyle} value={p.label ?? ''} placeholder={t('proc.paramLabel')} onChange={e => updateParam(i, { label: e.target.value })} />
                <select style={inputStyle} value={p.type} onChange={e => updateParam(i, { type: e.target.value as ParamType, default: e.target.value === 'secret' ? undefined : p.default })}>
                  {['text', 'number', 'date', 'select', 'secret'].map(x => <option key={x} value={x}>{x}</option>)}
                </select>
                <input style={inputStyle} value={p.type === 'select' ? (p.options ?? []).join(', ') : (p.default ?? '')} disabled={p.type === 'secret'}
                  placeholder={p.type === 'select' ? 'opzione1, opzione2' : t('proc.paramDefault')}
                  onChange={e => p.type === 'select'
                    ? updateParam(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })
                    : updateParam(i, { default: e.target.value })} />
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={p.required} onChange={e => updateParam(i, { required: e.target.checked })} /> {t('proc.required')}
                </label>
                <IconButton icon="Trash2" size="sm" danger onClick={() => update({ params: draft.params.filter((_, k) => k !== i) })} />
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`${t('proc.steps')} (${draft.steps.length})`}
        action={<Button size="sm" variant="outline" icon="Plus" onClick={() => insertStep(draft.steps.length)}>{t('proc.addStep')}</Button>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.steps.map((s, i) => (
            <StepCard
              key={s.id}
              step={s}
              index={i}
              total={draft.steps.length}
              t={t}
              onChange={(patch) => updateStep(i, patch)}
              onMove={(dir) => moveStep(i, dir)}
              onRemove={() => update({ steps: draft.steps.filter((_, k) => k !== i) })}
              onInsertAfter={() => insertStep(i + 1)}
              onMakeParam={(name) => { setDraft(d => makeParam(d, i, name)); setDirty(true); }}
              onRunUntil={() => startRun({ endAt: i, mode: 'test' })}
              onTest={() => startRun({ startAt: i, endAt: i, mode: 'test' })}
            />
          ))}
        </div>
      </Section>

      <Section title={t('proc.history')}>
        {!draft.runs?.length ? (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('proc.noRuns')}</span>
        ) : (
          <div className="ia-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {draft.runs.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                <Chip size="xs" tone={outcomeTone(r.outcome) as any}>{t(`proc.outcome.${r.outcome}`)}</Chip>
                <span style={{ color: 'var(--text-muted)' }}>{new Date(r.at).toLocaleString()}</span>
                <span>{r.mode} · {r.stepsDone} ✓ · {Math.round(r.durationMs / 1000)}s</span>
                {r.failedStep !== undefined && r.outcome !== 'success' && <span style={{ color: 'var(--error)' }}>#{r.failedStep + 1} {r.error ?? ''}</span>}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

interface StepCardProps {
  step: ProcedureStep;
  index: number;
  total: number;
  t: T;
  onChange: (patch: Partial<ProcedureStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onInsertAfter: () => void;
  onMakeParam: (name: string) => void;
  onRunUntil: () => void;
  onTest: () => void;
}

function StepCard({ step, index, total, t, onChange, onMove, onRemove, onInsertAfter, onMakeParam, onRunUntil, onTest }: StepCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [paramName, setParamName] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const targeted = TARGETED_STEPS.has(step.type) && !(step.type === 'scroll' && !step.target);
  const target = step.target;

  return (
    <div className="ia-card" data-testid={`step-${index}`} style={{ padding: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ width: 22, fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', paddingTop: 6, textAlign: 'right' }}>{index + 1}</div>
      {step.thumbnail ? (
        <img src={step.thumbnail} alt="" onClick={() => setZoom(z => !z)}
          style={{ width: zoom ? 360 : 120, borderRadius: 4, border: '1px solid var(--border)', cursor: 'zoom-in', flex: '0 0 auto' }} />
      ) : (
        <div style={{ width: 120, height: 70, flex: '0 0 auto', borderRadius: 4, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
          <LucideIcon name={step.type === 'ai' ? 'Bot' : step.type === 'navigate' ? 'Globe' : step.type === 'extract' ? 'Table' : 'MousePointerClick'} size={18} />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select style={{ ...inputStyle, width: 110 }} value={step.type} onChange={e => onChange({ type: e.target.value as StepType })}>
            {STEP_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
          <input style={inputStyle} value={step.description} onChange={e => onChange({ description: e.target.value })} />
        </div>

        {targeted && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {t('proc.stepTarget')}: <strong style={{ color: 'var(--text)' }}>{target?.label || target?.text || target?.candidates?.[0] || '—'}</strong>
            {target?.role ? ` (${target.role})` : ''}{target?.frameUrl ? ' [iframe]' : ''}
            <button onClick={() => setShowDetails(s => !s)} style={{ marginLeft: 6, border: 0, background: 'transparent', color: 'var(--primary)', cursor: 'pointer', fontSize: 11 }}>
              {showDetails ? '▲' : '▼'} selettori
            </button>
          </div>
        )}
        {targeted && showDetails && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <textarea style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 11, minHeight: 50 }}
              value={(target?.candidates ?? []).join('\n')}
              onChange={e => onChange({ target: { ...(target ?? { candidates: [] }), candidates: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } })} />
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={inputStyle} placeholder="label" value={target?.label ?? ''} onChange={e => onChange({ target: { ...(target ?? { candidates: [] }), label: e.target.value } })} />
              <input style={inputStyle} placeholder="text" value={target?.text ?? ''} onChange={e => onChange({ target: { ...(target ?? { candidates: [] }), text: e.target.value } })} />
              <input style={{ ...inputStyle, width: 110 }} placeholder="role" value={target?.role ?? ''} onChange={e => onChange({ target: { ...(target ?? { candidates: [] }), role: e.target.value } })} />
            </div>
          </div>
        )}

        {VALUE_STEPS.has(step.type) && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ ...labelStyle, width: 60 }}>{t('proc.stepValue')}</span>
            <input style={{ ...inputStyle, fontFamily: /\{\{/.test(step.value ?? '') ? 'var(--font-mono)' : 'inherit' }}
              value={step.value ?? ''} onChange={e => onChange({ value: e.target.value })}
              placeholder={step.type === 'wait' ? 'secondi' : step.type === 'press' ? 'Enter' : step.type === 'check' ? 'true / false' : step.type === 'scroll' ? 'down / up / top / bottom' : ''} />
            {(step.type === 'fill' || step.type === 'select') && !/^\{\{.*\}\}$/.test(step.value ?? '') && (
              paramName === null ? (
                <Button size="sm" variant="outline" onClick={() => setParamName((target?.label || 'valore').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30))}>{t('proc.makeParam')}</Button>
              ) : (
                <>
                  <input style={{ ...inputStyle, width: 140, fontFamily: 'var(--font-mono)' }} value={paramName} onChange={e => setParamName(e.target.value)} />
                  <IconButton icon="Check" size="sm" onClick={() => { onMakeParam(paramName || 'valore'); setParamName(null); }} />
                  <IconButton icon="X" size="sm" onClick={() => setParamName(null)} />
                </>
              )
            )}
          </div>
        )}

        {(step.type === 'ai' || step.type === 'extract') && (
          <textarea style={{ ...inputStyle, minHeight: 44, resize: 'vertical' }} value={step.instruction ?? ''}
            placeholder={step.type === 'ai' ? t('proc.stepInstruction') : 'hint (opzionale)'}
            onChange={e => onChange({ instruction: e.target.value })} />
        )}
        {step.type === 'extract' && (
          <SchemaField value={step.schema} onChange={(schema) => onChange({ schema })} label={t('proc.stepSchema')} />
        )}
        {(step.type === 'ai' || step.type === 'extract') && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ ...labelStyle, width: 120 }}>{t('proc.stepSaveAs')}</span>
            <input style={{ ...inputStyle, width: 180, fontFamily: 'var(--font-mono)' }} value={step.saveAs ?? ''} onChange={e => onChange({ saveAs: e.target.value.replace(/[^\w]/g, '_') || undefined })} />
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={!!step.optional} onChange={e => onChange({ optional: e.target.checked })} /> {t('proc.optional')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {t('proc.approval')}
            <select style={{ ...inputStyle, width: 'auto', padding: '2px 6px', fontSize: 11 }} value={step.approval ?? 'auto'} onChange={e => onChange({ approval: e.target.value as ApprovalSetting })}>
              <option value="auto">{t('proc.approval.auto')}</option>
              <option value="always">{t('proc.approval.always')}</option>
              <option value="never">{t('proc.approval.never')}</option>
            </select>
          </label>
          {step.pageUrl && <span style={{ color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }} title={step.pageUrl}>{step.pageUrl}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <IconButton icon="ChevronUp" size="sm" title={t('proc.moveUp')} disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon="ChevronDown" size="sm" title={t('proc.moveDown')} disabled={index === total - 1} onClick={() => onMove(1)} />
        <IconButton icon="Plus" size="sm" title={t('proc.addStep')} onClick={onInsertAfter} />
        <IconButton icon="StepForward" size="sm" title={t('proc.runUntil')} onClick={onRunUntil} />
        <IconButton icon="FlaskConical" size="sm" title={t('proc.testStep')} onClick={onTest} />
        <IconButton icon="Trash2" size="sm" danger title={t('proc.removeStep')} onClick={onRemove} />
      </div>
    </div>
  );
}

function SchemaField({ value, onChange, label }: { value?: Record<string, unknown>; onChange: (v: Record<string, unknown> | undefined) => void; label: string }) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <textarea
        style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 11, minHeight: 80, borderColor: error ? 'var(--error)' : 'var(--border)' }}
        value={text}
        placeholder='{"type":"object","properties":{"nome":{"type":"string"}}}'
        onChange={e => {
          setText(e.target.value);
          try {
            onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
            setError('');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'JSON');
          }
        }}
      />
      {error && <span style={{ fontSize: 11, color: 'var(--error)' }}>{error}</span>}
    </div>
  );
}

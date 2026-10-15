import React, { useState } from 'react';
import { ConfigManager } from '../../background/configManager';
import { useLang } from '../../i18n';
import { AgentFunction, FunctionMapping, ModelProfile } from '../../models/providers/types';
import { normalizeApiBase } from '../../models/providers/urlUtils';
import { Button, Chip, IconButton, FloatingInput, LucideIcon, Card, Toggle } from '../../ui';
import { Section } from './Section';

interface OpenAICompatibleSettingsProps {
  openaiCompatibleApiKey: string;
  setOpenaiCompatibleApiKey: (key: string) => void;
  openaiCompatibleBaseUrl: string;
  setOpenaiCompatibleBaseUrl: (url: string) => void;
  openaiCompatibleModelId: string;
  setOpenaiCompatibleModelId: (id: string) => void;
  profiles: ModelProfile[];
  setProfiles: (profiles: ModelProfile[]) => void;
  defaultProfileId: string;
  setDefaultProfileId: (id: string) => void;
  functionMappings: FunctionMapping[];
  setFunctionMappings: (mappings: FunctionMapping[]) => void;
}

function generateId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const ROUTABLE_FUNCTIONS: AgentFunction[] = [
  'automation', 'skill', 'recording', 'smartPaste', 'smartExtract', 'observation',
];

const MIN_CONTEXT_WINDOW = 64000;

const EMPTY_PROFILE: Omit<ModelProfile, 'id'> = {
  name: '',
  modelId: '',
  reasoningEffort: undefined,
  extraBody: undefined,
  contextWindowSize: 256000,
  temperature: 0,
  maxTokens: 8192,
};

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

function isValidExtraBody(s?: string): boolean {
  if (!s || !s.trim()) return true;
  try {
    const parsed = JSON.parse(s);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function KVField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: 0.5, fontWeight: 700, fontFamily: 'var(--font-mono)',
      }}>{label}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

interface ProfileEditorProps {
  profile: ModelProfile;
  onChange: (field: keyof ModelProfile, value: any) => void;
  onDone: () => void;
  onCancel: () => void;
  isNew?: boolean;
  apiKey: string;
  baseUrl: string;
  onResolvedBaseUrl: (url: string) => void;
}

function ProfileEditorInline({ profile, onChange, onDone, onCancel, isNew, apiKey, baseUrl, onResolvedBaseUrl }: ProfileEditorProps) {
  const { t } = useLang();
  const [modelsState, setModelsState] = useState<{ loading: boolean; error: string; models: { id: string; contextWindow?: number }[] }>({
    loading: false, error: '', models: [],
  });

  const handleLoadModels = async () => {
    if (!baseUrl) { setModelsState({ loading: false, error: t('openai.missingConfig'), models: [] }); return; }
    setModelsState({ loading: true, error: '', models: [] });
    const res = await ConfigManager.getInstance().fetchModels(baseUrl, apiKey);
    if (res.ok && res.models) {
      if (res.resolvedBaseUrl && res.resolvedBaseUrl !== baseUrl) onResolvedBaseUrl(res.resolvedBaseUrl);
      setModelsState({ loading: false, error: '', models: res.models });
    } else {
      setModelsState({ loading: false, error: res.error ?? 'Errore', models: [] });
    }
  };

  const handlePickModel = (id: string) => {
    if (!id) return;
    onChange('modelId', id);
    const found = modelsState.models.find(m => m.id === id);
    if (found?.contextWindow) onChange('contextWindowSize', found.contextWindow);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 11px', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)', outline: 'none', background: 'var(--surface)', color: 'var(--text)',
    fontFamily: 'inherit', fontSize: 12.5, boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5, display: 'block', fontFamily: 'var(--font-mono)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={labelStyle}>{t('openai.profiles.name')}</label>
          <input style={inputStyle} value={profile.name} onChange={e => onChange('name', e.target.value)} placeholder={t('openai.profiles.namePlaceholderNew')} />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>{t('openai.profiles.modelId')}</label>
            <button
              type="button"
              onClick={handleLoadModels}
              disabled={modelsState.loading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 7px',
                borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--primary)', cursor: modelsState.loading ? 'default' : 'pointer',
                fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700,
              }}
            >
              <LucideIcon name={modelsState.loading ? 'Loader' : 'Download'} size={11} />
              {modelsState.loading ? t('openai.models.loading') : t('openai.models.load')}
            </button>
          </div>
          <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={profile.modelId} onChange={e => onChange('modelId', e.target.value)} placeholder={t('openai.profiles.modelIdPlaceholder')} />
          {modelsState.models.length > 0 && (
            <select
              style={{ ...inputStyle, cursor: 'pointer', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              value={profile.modelId}
              onChange={e => handlePickModel(e.target.value)}
            >
              <option value="">{t('openai.models.choose')}</option>
              {modelsState.models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.contextWindow ? ` · ${(m.contextWindow / 1000).toFixed(0)}k` : ''}
                </option>
              ))}
            </select>
          )}
          {modelsState.error && (
            <div style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 4 }}>{modelsState.error}</div>
          )}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <div>
          <label style={labelStyle}>{t('openai.profiles.contextWindow')}</label>
          <input style={inputStyle} type="number" min={MIN_CONTEXT_WINDOW} step={1000}
            value={profile.contextWindowSize ?? ''}
            onChange={e => onChange('contextWindowSize', Number(e.target.value))}
            onBlur={e => {
              const v = Number(e.target.value);
              if (!v || v < MIN_CONTEXT_WINDOW) onChange('contextWindowSize', MIN_CONTEXT_WINDOW);
            }} />
        </div>
        <div>
          <label style={labelStyle}>{t('openai.profiles.temperature')}</label>
          <input style={inputStyle} type="number" step="0.1" min="0" max="2"
            value={profile.temperature ?? 0}
            onChange={e => onChange('temperature', Number(e.target.value))} />
        </div>
        <div>
          <label style={labelStyle}>{t('openai.profiles.maxTokens')}</label>
          <input style={inputStyle} type="number" value={profile.maxTokens ?? ''} onChange={e => onChange('maxTokens', Number(e.target.value))} />
        </div>
        <div>
          <label style={labelStyle}>{t('openai.profiles.reasoning')}</label>
          <select
            style={{ ...inputStyle, cursor: 'pointer' }}
            value={profile.reasoningEffort ?? ''}
            onChange={e => onChange('reasoningEffort', e.target.value || undefined)}
          >
            <option value="">{t('openai.profiles.reasoningOff')}</option>
            {REASONING_EFFORTS.map(effort => (
              <option key={effort} value={effort}>{effort}</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <label style={labelStyle}>{t('openai.profiles.extraBody')}</label>
        <textarea
          style={{
            ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 11.5,
            minHeight: 52, resize: 'vertical',
            borderColor: isValidExtraBody(profile.extraBody) ? 'var(--border)' : 'var(--error)',
          }}
          value={profile.extraBody ?? ''}
          placeholder={t('openai.profiles.extraBodyPlaceholder')}
          onChange={e => onChange('extraBody', e.target.value || undefined)}
        />
        <div style={{ fontSize: 10.5, color: isValidExtraBody(profile.extraBody) ? 'var(--text-muted)' : 'var(--error)', marginTop: 3 }}>
          {isValidExtraBody(profile.extraBody) ? t('openai.profiles.extraBodyHint') : t('openai.profiles.extraBodyInvalid')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <Toggle
            checked={profile.nativeToolCalling === true}
            onChange={() => onChange('nativeToolCalling', !profile.nativeToolCalling)}
            label={t('openai.profiles.nativeTools')}
          />
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{t('openai.profiles.nativeToolsHint')}</span>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('skills.cancel')}</Button>
        <Button size="sm" icon="Save" onClick={onDone}
          disabled={!profile.name.trim() || !profile.modelId.trim() || !isValidExtraBody(profile.extraBody)}>
          {isNew ? t('openai.profiles.add') : t('profile.save')}
        </Button>
      </div>
    </div>
  );
}

export function OpenAICompatibleSettings({
  openaiCompatibleApiKey,
  setOpenaiCompatibleApiKey,
  openaiCompatibleBaseUrl,
  setOpenaiCompatibleBaseUrl,
  openaiCompatibleModelId: _openaiCompatibleModelId,
  setOpenaiCompatibleModelId: _setOpenaiCompatibleModelId,
  profiles,
  setProfiles,
  defaultProfileId,
  setDefaultProfileId,
  functionMappings,
  setFunctionMappings,
}: OpenAICompatibleSettingsProps) {
  const { t } = useLang();

  const [testState, setTestState] = useState<{ loading: boolean; ok: boolean | null; message: string }>({
    loading: false, ok: null, message: '',
  });
  const [showKey, setShowKey] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newProfile, setNewProfile] = useState<ModelProfile>({ id: '', ...EMPTY_PROFILE });

  const isLocal = /localhost|127\.0\.0\.1/.test(openaiCompatibleBaseUrl);

  const handleTestConnection = async () => {
    if (!openaiCompatibleApiKey || !openaiCompatibleBaseUrl) {
      setTestState({ loading: false, ok: false, message: t('openai.missingConfig') });
      return;
    }
    const modelId = profiles.find(p => p.id === defaultProfileId)?.modelId
      || profiles[0]?.modelId
      || 'test';
    setTestState({ loading: true, ok: null, message: '' });
    const result = await ConfigManager.getInstance().testConnection(
      openaiCompatibleBaseUrl, openaiCompatibleApiKey, modelId
    );
    // Self-heal: if a different candidate (e.g. with /v1) worked, save it.
    if (result.resolvedBaseUrl && result.resolvedBaseUrl !== openaiCompatibleBaseUrl) {
      setOpenaiCompatibleBaseUrl(result.resolvedBaseUrl);
    }
    setTestState({
      loading: false,
      ok: result.ok,
      message: result.ok
        ? (result.resolvedBaseUrl && result.resolvedBaseUrl !== openaiCompatibleBaseUrl
            ? `${t('openai.connectionOk')} · ${result.resolvedBaseUrl}`
            : t('openai.connectionOk'))
        : (result.error ?? t('openai.missingConfig')),
    });
  };

  const handleRemoveProfile = (id: string) => {
    const updated = profiles.filter(p => p.id !== id);
    setProfiles(updated);
    if (defaultProfileId === id) setDefaultProfileId(updated[0]?.id ?? '');
    if (editingProfileId === id) setEditingProfileId(null);
  };

  const handleEditProfile = (id: string, field: keyof ModelProfile, value: any) => {
    setProfiles(profiles.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const handleAddProfile = () => {
    if (!newProfile.name.trim() || !newProfile.modelId.trim()) return;
    const id = generateId();
    const updated = [...profiles, { ...newProfile, id }];
    setProfiles(updated);
    if (!defaultProfileId) setDefaultProfileId(id);
    setNewProfile({ id: '', ...EMPTY_PROFILE });
    setShowNewForm(false);
  };

  const getMappedProfileId = (fn: AgentFunction): string =>
    functionMappings.find(m => m.function === fn)?.profileId ?? '';

  const handleFunctionMappingChange = (fn: AgentFunction, profileId: string) => {
    if (!profileId) {
      setFunctionMappings(functionMappings.filter(m => m.function !== fn));
    } else {
      const idx = functionMappings.findIndex(m => m.function === fn);
      if (idx >= 0) {
        const updated = [...functionMappings];
        updated[idx] = { function: fn, profileId };
        setFunctionMappings(updated);
      } else {
        setFunctionMappings([...functionMappings, { function: fn, profileId }]);
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 760 }}>

      {/* ── Credenziali ── */}
      <Section title={t('provider.title')} description={t('provider.desc')}>
        <Card padding={18}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', fontWeight: 700, fontSize: 13, marginBottom: 14 }}>
            <LucideIcon name="KeyRound" size={15} color="var(--primary)" /> {t('provider.openaiCompatible')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
            <FloatingInput
              label={t('openai.apiKey').replace(':', '')}
              value={showKey ? openaiCompatibleApiKey : (openaiCompatibleApiKey ? '••••••••••••••••••••' : '')}
              onChange={(v) => { if (showKey) setOpenaiCompatibleApiKey(v); }}
              icon="KeyRound"
              mono
              suffix={
                openaiCompatibleApiKey ? (
                  <button
                    onClick={() => setShowKey(s => !s)}
                    style={{ background: 'transparent', border: 0, padding: 4, cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', borderRadius: 4 }}
                  >
                    <LucideIcon name={showKey ? 'EyeOff' : 'Eye'} size={14} />
                  </button>
                ) : undefined
              }
            />
            <FloatingInput
              label={t('openai.baseUrl').replace(':', '')}
              value={openaiCompatibleBaseUrl}
              onChange={setOpenaiCompatibleBaseUrl}
              onBlur={() => { if (openaiCompatibleBaseUrl.trim()) setOpenaiCompatibleBaseUrl(normalizeApiBase(openaiCompatibleBaseUrl)); }}
              icon="Link"
              mono
            />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
            {t('openai.baseUrl.hint')}
          </div>
          {(!openaiCompatibleApiKey || showKey) && (
            <div style={{ marginTop: 12 }}>
              <label style={{
                fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 5, fontFamily: 'var(--font-mono)',
              }}>
                {openaiCompatibleApiKey ? t('openai.apiKeyEdit') : t('openai.apiKey').replace(':', '')}
              </label>
              <input
                type="text"
                value={openaiCompatibleApiKey}
                onChange={e => setOpenaiCompatibleApiKey(e.target.value)}
                placeholder="sk-…"
                style={{
                  width: '100%', padding: '8px 11px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', outline: 'none', background: 'var(--surface)', color: 'var(--text)',
                  fontFamily: 'var(--font-mono)', fontSize: 12, boxSizing: 'border-box',
                }}
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14 }}>
            <Button variant="outline" icon="Wifi" onClick={handleTestConnection} disabled={testState.loading}>
              {testState.loading ? t('openai.testing') : t('openai.testConnection')}
            </Button>
            {testState.ok === true && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <LucideIcon name="CheckCircle2" size={14} color="var(--success)" />
                <span style={{ color: 'var(--text)' }}>{testState.message}</span>
              </span>
            )}
            {testState.ok === false && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <LucideIcon name="XCircle" size={14} color="var(--error)" />
                <span style={{ color: 'var(--error)' }}>{testState.message}</span>
              </span>
            )}
          </div>
        </Card>
      </Section>

      {/* ── Profili modello ── */}
      <Section
        title={t('openai.profiles.title')}
        description={t('openai.profiles.desc')}
        action={
          <Button icon="Plus" size="sm" onClick={() => { setShowNewForm(true); setEditingProfileId(null); }}>
            {t('openai.profiles.new')}
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {profiles.length === 0 && !showNewForm && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '8px 0' }}>
              {t('openai.profiles.empty')}
            </div>
          )}

          {profiles.map(profile => (
            <Card key={profile.id} padding={14} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {editingProfileId === profile.id ? (
                <ProfileEditorInline
                  profile={profile}
                  onChange={(field, val) => handleEditProfile(profile.id, field, val)}
                  onDone={() => setEditingProfileId(null)}
                  onCancel={() => setEditingProfileId(null)}
                  apiKey={openaiCompatibleApiKey}
                  baseUrl={openaiCompatibleBaseUrl}
                  onResolvedBaseUrl={setOpenaiCompatibleBaseUrl}
                />
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{profile.name}</span>
                      {defaultProfileId === profile.id && <Chip size="xs" tone="primarySolid">{t('openai.profiles.default')}</Chip>}
                      {isLocal && <Chip size="xs" tone="success" dot>{t('openai.profiles.local')}</Chip>}
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)',
                        background: 'var(--surface-2)', padding: '2px 7px', borderRadius: 5, fontWeight: 500,
                      }}>{profile.modelId}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <IconButton
                        icon="Star" size="sm" title={t('openai.profiles.setDefault')}
                        active={defaultProfileId === profile.id}
                        onClick={() => setDefaultProfileId(profile.id)}
                      />
                      <IconButton icon="Pencil" size="sm" title={t('skills.edit')} onClick={() => { setEditingProfileId(profile.id); setShowNewForm(false); }} />
                      <IconButton icon="Trash2" size="sm" title={t('openai.profiles.remove')} danger onClick={() => handleRemoveProfile(profile.id)} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px 16px', fontSize: 11.5 }}>
                    <KVField label={t('openai.profiles.contextWindow')} value={profile.contextWindowSize?.toLocaleString() ?? '—'} />
                    <KVField label={t('openai.profiles.maxTokens')}     value={profile.maxTokens?.toLocaleString() ?? '—'} />
                    <KVField label={t('openai.profiles.temperature')}   value={profile.temperature?.toFixed(1) ?? '—'} />
                    <KVField label={t('openai.profiles.reasoning')}     value={profile.reasoningEffort ?? t('openai.profiles.reasoningOff')} />
                  </div>
                </>
              )}
            </Card>
          ))}

          {showNewForm && (
            <Card className="ia-expand-in" padding={14} style={{ border: '1.5px dashed var(--border)' }}>
              <ProfileEditorInline
                profile={newProfile}
                onChange={(field, val) => setNewProfile(p => ({ ...p, [field]: val }))}
                onDone={handleAddProfile}
                onCancel={() => { setShowNewForm(false); setNewProfile({ id: '', ...EMPTY_PROFILE }); }}
                isNew
                apiKey={openaiCompatibleApiKey}
                baseUrl={openaiCompatibleBaseUrl}
                onResolvedBaseUrl={setOpenaiCompatibleBaseUrl}
              />
            </Card>
          )}
        </div>
      </Section>

      {/* ── Function routing ── */}
      <Section title={t('openai.routing.title')} description={t('openai.routing.desc')}>
        <Card style={{ overflow: 'hidden' }}>
          {profiles.length === 0 ? (
            <div style={{ padding: '16px 14px', fontSize: 12.5, color: 'var(--text-muted)' }}>
              {t('openai.routing.noProfiles')}
            </div>
          ) : (
            ROUTABLE_FUNCTIONS.map((fn, i) => (
              <div key={fn} style={{
                display: 'grid', gridTemplateColumns: '150px 1fr 220px',
                padding: '12px 14px', alignItems: 'center', gap: 12,
                borderBottom: i < ROUTABLE_FUNCTIONS.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{fn}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t(`function.${fn}`)}</span>
                <select
                  value={getMappedProfileId(fn)}
                  onChange={e => handleFunctionMappingChange(fn, e.target.value)}
                  style={{
                    height: 32, padding: '0 10px', borderRadius: 'var(--radius-md)',
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    fontSize: 12, color: 'var(--text)', cursor: 'pointer',
                    fontFamily: 'inherit', width: '100%', outline: 'none',
                  }}
                >
                  <option value="">{t('openai.routing.useDefault')}</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            ))
          )}
        </Card>
      </Section>
    </div>
  );
}

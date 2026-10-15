import React, { useState, useEffect, useRef } from 'react';
import { DomainProfile, DomainProfileManager } from '../../../agent/domainProfileManager';
import { useLang } from '../../../i18n';
import { Button, Toggle } from '../../../ui';
import { LucideIcon } from '../../../ui';
import { Section } from '../Section';

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const EMPTY_PROFILE: Omit<DomainProfile, 'id'> = {
  display_name: '',
  domain_pattern: '',
  system_prompt_addendum: '',
  hints: '',
  enabled: true,
};

const miniTextarea: React.CSSProperties = {
  width: '100%', minHeight: 70, padding: 10, border: '1px solid var(--border)',
  borderRadius: 6, outline: 'none', resize: 'vertical', boxSizing: 'border-box',
  fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5,
  background: 'var(--surface-2)', color: 'var(--text)',
};

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
    {children}
  </div>
);

export function DomainProfilesTab() {
  const { t } = useLang();
  const [profiles, setProfiles] = useState<DomainProfile[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DomainProfile | null>(null);
  const [jsonError, setJsonError] = useState('');
  const [schemaText, setSchemaText] = useState('');
  const [openAccordion, setOpenAccordion] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const list = await DomainProfileManager.getInstance().listProfiles();
    setProfiles(list);
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    const p: DomainProfile = { id: generateId(), ...EMPTY_PROFILE };
    setDraft(p); setSchemaText(''); setJsonError(''); setEditingId('__new__');
  };

  const openEdit = (profile: DomainProfile) => {
    setDraft({ ...profile });
    setSchemaText(profile.default_schema ? JSON.stringify(profile.default_schema, null, 2) : '');
    setJsonError(''); setEditingId(profile.id);
  };

  const cancelEdit = () => { setEditingId(null); setDraft(null); setJsonError(''); };

  const handleSave = async () => {
    if (!draft) return;
    let default_schema: object | undefined = undefined;
    if (schemaText.trim()) {
      try { default_schema = JSON.parse(schemaText); }
      catch { setJsonError(t('profile.invalidJson')); return; }
    }
    await DomainProfileManager.getInstance().saveProfile({ ...draft, default_schema });
    cancelEdit(); await load();
  };

  const handleDelete = async (id: string) => {
    await DomainProfileManager.getInstance().deleteProfile(id);
    await load();
  };

  const handleToggle = async (profile: DomainProfile) => {
    await DomainProfileManager.getInstance().saveProfile({ ...profile, enabled: !profile.enabled });
    await load();
  };

  const handleExport = async () => {
    const list = await DomainProfileManager.getInstance().listProfiles();
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'domain-profiles.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const list = JSON.parse(ev.target?.result as string) as DomainProfile[];
        if (!Array.isArray(list)) throw new Error();
        for (const p of list) await DomainProfileManager.getInstance().saveProfile(p);
        await load();
      } catch { /* silently ignore */ }
    };
    reader.readAsText(file); e.target.value = '';
  };

  const isEditing = (id: string) => editingId === id || (editingId === '__new__' && id === draft?.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Section
        title={t('profile.title')}
        description={t('profile.desc')}
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="outline" size="sm" icon="Download" onClick={handleExport} data-testid="btn-export-profiles">{t('profile.export')}</Button>
            <Button variant="outline" size="sm" icon="Upload" onClick={() => fileInputRef.current?.click()} data-testid="btn-import-profiles">{t('profile.import')}</Button>
            <Button size="sm" icon="Plus" onClick={openNew} data-testid="btn-new-profile">{t('profile.new')}</Button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="profile-list">
          {profiles.length === 0 && !isEditing('__new__') && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '16px 0' }} data-testid="profile-list-empty">
              {t('profile.empty')}
            </div>
          )}

          {profiles.map((profile) => (
            <div key={profile.id} className="ia-card" style={{ overflow: 'hidden' }} data-testid={`profile-item-${profile.id}`}>
              {isEditing(profile.id) && draft ? (
                <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="profile-editor">
                  <ProfileEditorForm
                    draft={draft} schemaText={schemaText} jsonError={jsonError}
                    onChange={setDraft} onSchemaChange={setSchemaText}
                    onSave={handleSave} onCancel={cancelEdit} t={t}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setOpenAccordion(openAccordion === profile.id ? null : profile.id)}
                  style={{
                    width: '100%', padding: 14, border: 0, background: 'transparent',
                    cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 12,
                  }}
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: 9, flex: '0 0 auto',
                    background: 'var(--surface-2)', color: 'var(--text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <LucideIcon name="Globe" size={17} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{profile.display_name}</span>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)',
                        background: 'var(--surface-2)', padding: '2px 7px', borderRadius: 4,
                      }}>{profile.domain_pattern}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                      {profile.hints ? `${profile.hints.split('\n').filter(Boolean).length} hint selettori` : '0 hint'}
                    </div>
                  </div>
                  <LucideIcon name={openAccordion === profile.id ? 'ChevronUp' : 'ChevronDown'} size={14} color="var(--text-muted)" />
                </button>
              )}

              {openAccordion === profile.id && !isEditing(profile.id) && (
                <div className="ia-expand-in" style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div><FieldLabel>Addendum prompt</FieldLabel>
                    <textarea style={miniTextarea} value={profile.system_prompt_addendum ?? ''} readOnly />
                  </div>
                  <div><FieldLabel>Hint selettori CSS</FieldLabel>
                    <textarea style={{ ...miniTextarea, fontFamily: 'var(--font-mono)' }} value={profile.hints ?? ''} readOnly />
                  </div>
                  {profile.default_schema && (
                    <div><FieldLabel>Schema JSON di default</FieldLabel>
                      <textarea style={{ ...miniTextarea, fontFamily: 'var(--font-mono)', background: 'var(--code-bg)', color: 'var(--code-fg)', borderColor: 'transparent' }}
                        value={JSON.stringify(profile.default_schema, null, 2)} readOnly />
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Toggle checked={profile.enabled} onChange={() => handleToggle(profile)} label={profile.enabled ? 'Abilitato' : 'Disabilitato'} />
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" icon="Trash2" danger onClick={() => handleDelete(profile.id)} data-testid={`btn-delete-profile-${profile.id}`}>Elimina</Button>
                      <Button size="sm" icon="Pencil" onClick={() => openEdit(profile)} data-testid={`btn-edit-profile-${profile.id}`}>Modifica</Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {editingId === '__new__' && draft && (
            <div className="ia-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="profile-editor-new">
              <ProfileEditorForm
                draft={draft} schemaText={schemaText} jsonError={jsonError}
                onChange={setDraft} onSchemaChange={setSchemaText}
                onSave={handleSave} onCancel={cancelEdit} t={t}
              />
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

interface EditorFormProps {
  draft: DomainProfile;
  schemaText: string;
  jsonError: string;
  onChange: (p: DomainProfile) => void;
  onSchemaChange: (s: string) => void;
  onSave: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}

function ProfileEditorForm({ draft, schemaText, jsonError, onChange, onSchemaChange, onSave, onCancel, t }: EditorFormProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="profile-editor">
      <div>
        <FieldLabel>{t('profile.editorName')}</FieldLabel>
        <input value={draft.display_name} onChange={(e) => onChange({ ...draft, display_name: e.target.value })}
          placeholder={t('profile.namePlaceholder')} data-testid="profile-editor-name"
          style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, outline: 'none', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12.5, boxSizing: 'border-box' }}
        />
      </div>
      <div>
        <FieldLabel>{t('profile.editorPattern')}</FieldLabel>
        <input value={draft.domain_pattern} onChange={(e) => onChange({ ...draft, domain_pattern: e.target.value })}
          placeholder={t('profile.patternPlaceholder')} data-testid="profile-editor-pattern"
          style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, outline: 'none', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, boxSizing: 'border-box' }}
        />
      </div>
      <div>
        <FieldLabel>{t('profile.editorAddendum')}</FieldLabel>
        <textarea style={miniTextarea} value={draft.system_prompt_addendum ?? ''}
          onChange={(e) => onChange({ ...draft, system_prompt_addendum: e.target.value })}
          placeholder={t('profile.addendumPlaceholder')} data-testid="profile-editor-addendum" />
      </div>
      <div>
        <FieldLabel>{t('profile.editorHints')}</FieldLabel>
        <textarea style={{ ...miniTextarea, fontFamily: 'var(--font-mono)' }} value={draft.hints ?? ''}
          onChange={(e) => onChange({ ...draft, hints: e.target.value })}
          placeholder={t('profile.hintsPlaceholder')} data-testid="profile-editor-hints" />
      </div>
      <div>
        <FieldLabel>{t('profile.editorSchema')}</FieldLabel>
        <textarea style={{ ...miniTextarea, fontFamily: 'var(--font-mono)', background: 'var(--code-bg)', color: 'var(--code-fg)', borderColor: 'transparent' }}
          value={schemaText} onChange={(e) => onSchemaChange(e.target.value)}
          placeholder='{"type":"object","properties":{}}' data-testid="profile-editor-schema" />
        {jsonError && <div style={{ fontSize: 11.5, color: 'var(--error)', marginTop: 4 }}>{jsonError}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="btn-cancel-profile">{t('profile.cancel')}</Button>
        <Button size="sm" icon="Save" onClick={onSave}
          disabled={!draft.display_name.trim() || !draft.domain_pattern.trim()}
          data-testid="btn-save-profile">{t('profile.save')}</Button>
      </div>
    </div>
  );
}

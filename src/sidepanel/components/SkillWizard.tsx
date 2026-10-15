import React, { useEffect, useMemo, useState } from 'react';
import { Recording } from '../../background/recordingManager';
import {
  AnalysisResult,
  VariableCandidate,
  VariableChoice,
  VariableChoiceType,
  buildAnalysisPrompt,
  findVariableCandidates,
  generateSkill,
  parseAnalysisResponse,
} from '../../agent/skillGenerator';
import { parseSkill, SkillManager } from '../../agent/skillManager';
import { useLang } from '../../i18n';
import { Button } from '../../ui';

interface SkillWizardProps {
  recording: Recording;
  onClose: () => void;
  onCreated: (skillTitle: string) => void;
}

const EXPRESSION_PRESETS = [
  { value: 'oggi:GG/MM/AAAA', labelKey: 'wizard.expr.today' },
  { value: 'oggi', labelKey: 'wizard.expr.todayIso' },
  { value: 'oggi+7g:GG/MM/AAAA', labelKey: 'wizard.expr.todayPlus7' },
  { value: 'oggi-1g:GG/MM/AAAA', labelKey: 'wizard.expr.todayMinus1' },
  { value: 'ora', labelKey: 'wizard.expr.now' },
];

interface CandidateState extends VariableCandidate {
  choice: VariableChoiceType;
  name: string;
  expression: string;
  aiInstruction: string;
}

async function analyzeWithLLM(recording: Recording, lang: 'it' | 'en'): Promise<AnalysisResult | null> {
  try {
    const { ConfigManager } = await import('../../background/configManager');
    const cfg = ConfigManager.getInstance();
    const [config, profile] = await Promise.all([cfg.getProviderConfig(), cfg.getActiveProfile()]);
    if (!config.apiKey || !config.baseUrl) return null;

    const body: Record<string, unknown> = {
      model: profile?.modelId || config.apiModelId || '',
      messages: [{ role: 'user', content: buildAnalysisPrompt(recording, lang) }],
      stream: false,
      max_completion_tokens: 2048,
      temperature: 0,
    };
    if (profile?.reasoningEffort) body.reasoning_effort = profile.reasoningEffort;
    if (profile?.extraBody) {
      try { Object.assign(body, JSON.parse(profile.extraBody)); } catch { /* ignore */ }
    }

    const resp = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    return parseAnalysisResponse(content);
  } catch {
    return null;
  }
}

export const SkillWizard: React.FC<SkillWizardProps> = ({ recording, onClose, onCreated }) => {
  const { t, lang } = useLang();
  const heuristicCandidates = useMemo(() => findVariableCandidates(recording), [recording]);

  const [title, setTitle] = useState(recording.name);
  const [description, setDescription] = useState(recording.description || '');
  const [notes, setNotes] = useState('');
  const [candidates, setCandidates] = useState<CandidateState[]>(
    heuristicCandidates.map(c => ({ ...c, choice: 'fixed' as VariableChoiceType, name: c.suggestedName, expression: EXPRESSION_PRESETS[0].value, aiInstruction: '' }))
  );
  const [analyzing, setAnalyzing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    analyzeWithLLM(recording, lang === 'en' ? 'en' : 'it').then(analysis => {
      if (cancelled || !analysis) { setAnalyzing(false); return; }
      if (analysis.title) setTitle(prev => prev === recording.name ? analysis.title! : prev);
      if (analysis.description) setDescription(prev => prev || analysis.description!);
      if (analysis.variables?.length) {
        setCandidates(prev => prev.map(c => {
          const suggestion = analysis.variables!.find(v => v.stepIndex === c.stepIndex);
          // The LLM suggests it should be variable → preselect param with its name
          return suggestion ? { ...c, choice: 'param' as VariableChoiceType, name: suggestion.name } : c;
        }));
      }
      setAnalyzing(false);
    });
    return () => { cancelled = true; };
  }, [recording, lang]);

  const updateCandidate = (stepIndex: number, patch: Partial<CandidateState>) => {
    setCandidates(prev => prev.map(c => c.stepIndex === stepIndex ? { ...c, ...patch } : c));
  };

  const handleCreate = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    try {
      const choices: VariableChoice[] = candidates.map(c => ({
        stepIndex: c.stepIndex,
        type: c.choice,
        name: c.name.trim() || c.suggestedName,
        expression: c.expression,
        aiInstruction: c.aiInstruction.trim(),
      }));
      const generated = generateSkill(recording, { title: title.trim(), description: description.trim(), notes }, choices);

      // Save the parametrized recording (placeholders resolved at replay time)
      const stored = await chrome.storage.local.get('recordings');
      const all = (stored.recordings as Record<string, Recording>) ?? {};
      all[generated.updatedRecording.name] = generated.updatedRecording;
      await chrome.storage.local.set({ recordings: all });

      // Save the skill
      const skill = parseSkill(generated.markdown);
      await SkillManager.getInstance().saveSkill(skill);

      onCreated(skill.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '5px 8px', fontSize: 11.5, border: '1px solid var(--border)',
    borderRadius: 6, outline: 'none', background: 'var(--surface)', color: 'var(--text)',
    fontFamily: 'inherit', boxSizing: 'border-box',
  };
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
  const labelStyle: React.CSSProperties = {
    fontSize: 9.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5,
  };

  return (
    <div className="ia-card" data-testid="skill-wizard" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{t('wizard.title')}</span>
        {analyzing && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('wizard.analyzing')}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{t('wizard.skillName')}</span>
        <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} data-testid="wizard-title" />
        <span style={labelStyle}>{t('wizard.skillDescription')}</span>
        <input style={inputStyle} value={description} onChange={e => setDescription(e.target.value)} data-testid="wizard-description" />
      </div>

      {candidates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={labelStyle}>{t('wizard.variables')}</span>
          {candidates.map(c => (
            <div key={c.stepIndex} className="ia-card-sm" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--text)' }}>
                <strong>{c.fieldLabel ?? `Step ${c.stepIndex + 1}`}</strong>
                <span style={{ color: 'var(--text-muted)' }}> — {t('wizard.recordedValue')}: “{c.recordedValue.slice(0, 60)}”</span>
              </div>
              <select
                style={selectStyle}
                value={c.choice}
                onChange={e => updateCandidate(c.stepIndex, { choice: e.target.value as VariableChoiceType })}
                data-testid={`wizard-choice-${c.stepIndex}`}
              >
                <option value="fixed">{t('wizard.choice.fixed')}</option>
                <option value="param">{t('wizard.choice.param')}</option>
                <option value="expression">{t('wizard.choice.expression')}</option>
                <option value="ai">{t('wizard.choice.ai')}</option>
              </select>
              {c.choice === 'param' && (
                <input style={inputStyle} value={c.name} placeholder={t('wizard.paramName')}
                  onChange={e => updateCandidate(c.stepIndex, { name: e.target.value })} />
              )}
              {c.choice === 'expression' && (
                <select style={selectStyle} value={c.expression}
                  onChange={e => updateCandidate(c.stepIndex, { expression: e.target.value })}>
                  {EXPRESSION_PRESETS.map(p => (
                    <option key={p.value} value={p.value}>{t(p.labelKey)} — {`{{${p.value}}}`}</option>
                  ))}
                </select>
              )}
              {c.choice === 'ai' && (
                <>
                  <input style={inputStyle} value={c.name} placeholder={t('wizard.paramName')}
                    onChange={e => updateCandidate(c.stepIndex, { name: e.target.value })} />
                  <textarea style={{ ...inputStyle, minHeight: 40, resize: 'vertical' }} value={c.aiInstruction}
                    placeholder={t('wizard.aiInstructionPlaceholder')}
                    onChange={e => updateCandidate(c.stepIndex, { aiInstruction: e.target.value })} />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{t('wizard.notes')}</span>
        <textarea style={{ ...inputStyle, minHeight: 44, resize: 'vertical' }} value={notes}
          placeholder={t('wizard.notesPlaceholder')}
          onChange={e => setNotes(e.target.value)} data-testid="wizard-notes" />
      </div>

      {error && <div style={{ fontSize: 11, color: 'var(--error)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 6 }}>
        <Button size="sm" variant="ghost" fullWidth onClick={onClose}>{t('wizard.cancel')}</Button>
        <Button size="sm" icon="Sparkles" fullWidth onClick={handleCreate} disabled={saving || !title.trim()} data-testid="wizard-create">
          {saving ? t('wizard.creating') : t('wizard.create')}
        </Button>
      </div>
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import { ConfigManager } from '../../../background/configManager';
import { useLang, saveLang, Lang } from '../../../i18n';
import { Chip, SegmentedControl, Button, Card, Toggle } from '../../../ui';
import { Section } from '../Section';

export function GeneralTab() {
  const { t, lang } = useLang();
  const [customPrompt, setCustomPrompt] = useState('');
  const [promptSaved, setPromptSaved] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [maxSteps, setMaxSteps] = useState(200);
  const [maxStepsSaved, setMaxStepsSaved] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [planningEnabled, setPlanningEnabled] = useState(true);

  useEffect(() => {
    ConfigManager.getInstance().getCustomSystemPrompt().then(p => setCustomPrompt(p || ''));
    ConfigManager.getInstance().getMaxSteps().then(n => setMaxSteps(n));
    ConfigManager.getInstance().getDebugMode().then(d => setDebugMode(d));
    ConfigManager.getInstance().getPlanningEnabled().then(p => setPlanningEnabled(p));
  }, []);

  const handleToggleDebug = async (v: boolean) => {
    setDebugMode(v);
    await ConfigManager.getInstance().setDebugMode(v);
  };

  const handleTogglePlanning = async (v: boolean) => {
    setPlanningEnabled(v);
    await ConfigManager.getInstance().setPlanningEnabled(v);
  };

  const handleSavePrompt = async () => {
    await ConfigManager.getInstance().setCustomSystemPrompt(customPrompt);
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 2000);
  };

  const handleResetPrompt = async () => {
    setCustomPrompt('');
    await ConfigManager.getInstance().setCustomSystemPrompt('');
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 2000);
  };

  const handleSaveMaxSteps = async () => {
    await ConfigManager.getInstance().setMaxSteps(maxSteps);
    setMaxStepsSaved(true);
    setTimeout(() => setMaxStepsSaved(false), 2000);
  };

  const handleResetMaxSteps = async () => {
    setMaxSteps(200);
    await ConfigManager.getInstance().setMaxSteps(200);
    setMaxStepsSaved(true);
    setTimeout(() => setMaxStepsSaved(false), 2000);
  };

  const steps = [
    { n: 1, title: t('general.steps.1.title'), body: t('general.steps.1.desc') },
    { n: 2, title: t('general.steps.2.title'), body: t('general.steps.2.desc') },
    { n: 3, title: t('general.steps.3.title'), body: t('general.steps.3.desc') },
  ];

  const tips = [t('general.tips.1'), t('general.tips.2'), t('general.tips.3')];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 720 }}>
      <Section title={t('general.gettingStarted')} description={t('general.steps.intro')}>
        <Card padding="6px 4px">
          {steps.map((s, i) => (
            <div key={s.n} style={{
              display: 'flex', gap: 14, padding: '14px 16px',
              borderBottom: i < steps.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{
                width: 26, height: 26, borderRadius: 999, flex: '0 0 auto',
                background: 'var(--primary-soft)', color: 'var(--primary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 12,
              }}>{s.n}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{s.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{s.body}</div>
              </div>
            </div>
          ))}
        </Card>
      </Section>

      <Section title={t('general.tips.title')} description={t('general.tipsDesc')}>
        <Card style={{ overflow: 'hidden' }}>
          <button
            onClick={() => setTipsOpen(!tipsOpen)}
            style={{
              width: '100%', padding: '12px 14px', border: 0, background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontFamily: 'inherit',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
              <span style={{ color: 'var(--warning-fg)' }}>💡</span> {tips.length} {t('general.tips.count')}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tipsOpen ? '▲' : '▼'}</span>
          </button>
          {tipsOpen && (
            <div className="ia-expand-in" style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tips.map((tip, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, color: 'var(--text)' }}>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>0{i + 1}</span>
                  <span style={{ flex: 1, lineHeight: 1.5 }}>{tip}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>

      <Section title={t('general.language')}>
        <SegmentedControl
          options={[
            { value: 'it', label: t('general.language.it') },
            { value: 'en', label: t('general.language.en') },
          ]}
          value={lang}
          onChange={(v) => saveLang(v as Lang)}
        />
      </Section>

      <Section title={t('general.maxSteps.title')} description={t('general.maxSteps.desc')}>
        <Card style={{ display: 'flex', alignItems: 'flex-end', gap: 12, padding: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 180px' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              {t('general.maxSteps.label')}
            </label>
            <input
              type="number"
              min={1}
              max={10000}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))}
              style={{
                width: 130, padding: '8px 10px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
                fontFamily: 'inherit', fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {maxStepsSaved && <Chip size="xs" tone="success" dot>{t('general.saved')}</Chip>}
            <Button variant="outline" icon="RotateCcw" onClick={handleResetMaxSteps}>
              {t('general.maxSteps.reset')}
            </Button>
            <Button icon="Save" onClick={handleSaveMaxSteps}>
              {maxStepsSaved ? `✓ ${t('general.saved')}` : t('general.customPrompt.save')}
            </Button>
          </div>
        </Card>
      </Section>

      <Section title={t('general.planning.title')} description={t('general.planning.desc')}>
        <Card style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
          <Toggle checked={planningEnabled} onChange={handleTogglePlanning} label={t('general.planning.label')} />
        </Card>
      </Section>

      <Section title={t('general.debug.title')} description={t('general.debug.desc')}>
        <Card style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
          <Toggle checked={debugMode} onChange={handleToggleDebug} label={t('general.debug.label')} />
          {debugMode && <Chip size="xs" tone="warning" dot>{t('general.debug.on')}</Chip>}
          <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45, textAlign: 'right' }}>
            {t('general.debug.hint')}
          </span>
        </Card>
      </Section>

      <Section title={t('general.customPrompt.title')} description={t('general.customPrompt.desc')}>
        <Card style={{ overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
              system_prompt.md · {customPrompt.split('\n').length} {t('general.lines')} · {customPrompt.length} {t('general.chars')}
            </span>
            {promptSaved && <Chip size="xs" tone="success" dot>{t('general.saved')}</Chip>}
            {customPrompt && !promptSaved && <Chip size="xs" tone="warning">{t('general.customPrompt.active')}</Chip>}
          </div>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={t('general.customPrompt.placeholder')}
            style={{
              width: '100%', minHeight: 130, padding: 14, border: 0, outline: 'none', resize: 'vertical',
              fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55,
              background: 'var(--code-bg)', color: 'var(--code-fg)', boxSizing: 'border-box',
            }}
          />
        </Card>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="outline" icon="RotateCcw" onClick={handleResetPrompt}>
            {t('general.customPrompt.reset')}
          </Button>
          <Button icon="Save" onClick={handleSavePrompt}>
            {promptSaved ? `✓ ${t('general.saved')}` : t('general.customPrompt.save')}
          </Button>
        </div>
      </Section>
    </div>
  );
}

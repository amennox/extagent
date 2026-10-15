/// <reference types="chrome"/>
import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SkillDefinition, SkillManager, parseSkill } from '../../../agent/skillManager';
import { TOOL_DESCRIPTIONS_EN } from '../../../agent/tools/descriptions.en';
import { useLang } from '../../../i18n';
import { Button, IconButton, Chip, FloatingInput, LucideIcon } from '../../../ui';
import { Section } from '../Section';

// ─── Static tool data ─────────────────────────────────────────────────────────

const STEP_COMMANDS = ['navigate', 'extract', 'paginate', 'fill', 'play', 'export'] as const;

const STEP_COMMAND_DESCRIPTIONS: Record<string, string> = {
  navigate: 'Naviga a un URL',
  extract:  'Estrai dati strutturati (JSON schema)',
  paginate: 'Raccolta multi-pagina con paginazione',
  fill:     'Compila campi di un form',
  play:     'Esegui una registrazione salvata',
  export:   'Esporta i dati raccolti',
};

const TOOL_GROUPS: { label: string; tools: string[] }[] = [
  { label: 'Navigation',     tools: ['browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_wait_for_navigation'] },
  { label: 'Interaction',    tools: ['browser_click', 'browser_type', 'browser_handle_dialog'] },
  { label: 'Observation',    tools: ['browser_get_title', 'browser_snapshot_dom', 'browser_query', 'browser_accessible_tree', 'browser_read_text', 'browser_screenshot'] },
  { label: 'Keyboard/Mouse', tools: ['browser_keyboard_type', 'browser_press_key', 'browser_move_mouse', 'browser_click_xy', 'browser_drag'] },
  { label: 'Tabs',           tools: ['browser_tab_list', 'browser_tab_new', 'browser_tab_select', 'browser_tab_close', 'browser_get_active_tab', 'browser_navigate_tab', 'browser_screenshot_tab'] },
  { label: 'Memory',         tools: ['save_memory', 'lookup_memories', 'get_all_memories', 'delete_memory', 'clear_all_memories'] },
  { label: 'Data / AI',      tools: ['extract_with_schema', 'paginate_and_collect', 'fill_form_from_data', 'play_automation', 'use_skill'] },
];

// ─── System prompt builder ────────────────────────────────────────────────────

function buildImprovementSystemPrompt(): string {
  const toolCount = Object.keys(TOOL_DESCRIPTIONS_EN).length;
  const toolList = Object.entries(TOOL_DESCRIPTIONS_EN)
    .map(([name, desc]) => `- \`${name}\`: ${desc}`)
    .join('\n');

  return `You are an expert at writing DomMotion browser automation skills.

A skill is a Markdown document describing a browser automation workflow.

## Skill format

\`\`\`markdown
---
title: Skill title
description: Brief one-line description
---

## Steps

1. Navigate to the target page
   - \`navigate: https://example.com\`

2. Extract structured data
   - \`extract: {"type":"object","properties":{"name":{"type":"string"}}}\`
\`\`\`

## Valid step commands (must be wrapped in backticks)

- \`navigate: <url>\` — Navigate the browser to a URL
- \`extract: <json-schema>\` — Extract structured JSON data from the current page
- \`paginate: <options-json>\` — Collect data across multiple pages with pagination
- \`fill: <json>\` — Fill form fields from a structured data payload
- \`play: <recording-name>\` — Replay a previously recorded automation sequence
- \`export: <format>\` — Export collected data (csv, json, etc.)

## Available browser tools (${toolCount} tools)

${toolList}

## Your task

The user will provide a skill in Markdown format (including frontmatter).
Improve the skill body to be:
- Clearer and more descriptive in each step
- Better structured with numbered steps and sub-bullets for commands
- Including step commands where appropriate
- Referencing specific tool names where helpful for the LLM

Rules:
- Return ONLY the improved Markdown body (everything AFTER the closing --- of the frontmatter)
- Do NOT include the frontmatter block
- Do NOT wrap in \`\`\`markdown code fences
- Do NOT add explanations or preamble
- Preserve all existing step commands (\`navigate:\`, \`extract:\`, etc.)`;
}

// ─── Markdown components (token-based, no DaisyUI) ───────────────────────────

const mdComponents = {
  p:          ({ node: _, ...p }: any) => <p style={{ marginBottom: 8, lineHeight: 1.6 }} {...p} />,
  h1:         ({ node: _, ...p }: any) => <h1 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: 'var(--text)', borderBottom: '1px solid var(--border)', paddingBottom: 4 }} {...p} />,
  h2:         ({ node: _, ...p }: any) => <h2 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6, color: 'var(--text)' }} {...p} />,
  h3:         ({ node: _, ...p }: any) => <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }} {...p} />,
  ul:         ({ node: _, ...p }: any) => <ul style={{ paddingLeft: 18, marginBottom: 8 }} {...p} />,
  ol:         ({ node: _, ...p }: any) => <ol style={{ paddingLeft: 18, marginBottom: 8 }} {...p} />,
  li:         ({ node: _, ...p }: any) => <li style={{ marginBottom: 2 }} {...p} />,
  blockquote: ({ node: _, ...p }: any) => <blockquote style={{ borderLeft: '3px solid var(--border-strong)', paddingLeft: 12, color: 'var(--text-muted)', margin: '8px 0', fontStyle: 'italic' }} {...p} />,
  a:          ({ node: _, ...p }: any) => <a style={{ color: 'var(--primary)', textDecoration: 'underline' }} {...p} />,
  code:       ({ node: _, children, className, ...p }: any) => {
    const isBlock = !!className;
    return isBlock
      ? <pre style={{ background: 'var(--code-bg)', color: 'var(--code-fg)', borderRadius: 6, padding: '8px 12px', overflowX: 'auto', fontSize: 11.5, margin: '6px 0' }}><code {...p}>{children}</code></pre>
      : <code style={{ background: 'var(--surface-2)', color: 'var(--primary)', borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--font-mono)', fontSize: 11.5 }} {...p}>{children}</code>;
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countSteps(body: string): number {
  return (body.match(/`(navigate|extract|paginate|fill|play|export):/g) ?? []).length;
}

// ─── SkillEditorPanel ─────────────────────────────────────────────────────────

interface SkillEditorPanelProps {
  title: string;
  description: string;
  body: string;
  onTitleChange: (v: string) => void;
  onDescChange:  (v: string) => void;
  onBodyChange:  (v: string) => void;
  onSave:   () => void;
  onCancel: () => void;
  t: (key: string) => string;
}

function SkillEditorPanel({
  title, description, body,
  onTitleChange, onDescChange, onBodyChange,
  onSave, onCancel, t,
}: SkillEditorPanelProps) {
  const [view, setView]           = useState<'edit' | 'preview'>('edit');
  const [dropOpen, setDropOpen]   = useState(false);
  const [aiImproving, setAiImproving] = useState(false);
  const [aiError, setAiError]     = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [dropOpen]);

  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current;
    if (!ta) { onBodyChange(body + text); return; }
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    onBodyChange(body.slice(0, start) + text + body.slice(end));
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + text.length;
      ta.focus();
    });
  }, [body, onBodyChange]);

  const handleInsert = (name: string, isStepCmd: boolean) => {
    insertAtCursor(isStepCmd ? `\`${name}: \`` : `\`${name}\``);
    setDropOpen(false);
  };

  const handleImproveWithAI = async () => {
    setAiImproving(true);
    setAiError('');
    try {
      const { ConfigManager } = await import('../../../background/configManager');
      const cfg = ConfigManager.getInstance();
      const [config, profile] = await Promise.all([
        cfg.getProviderConfig(),
        cfg.getActiveProfile(),
      ]);

      if (!config.apiKey || !config.baseUrl) {
        setAiError('Configura prima le credenziali LLM.');
        return;
      }

      const modelId = profile?.modelId || config.apiModelId || '';
      const fullMd  = `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}`;

      // Standard OpenAI-compatible body (aligned with the provider): reasoning
      // via reasoning_effort, non-standard params via the profile's extraBody.
      const requestBody: Record<string, unknown> = {
        model: modelId,
        messages: [
          { role: 'system', content: buildImprovementSystemPrompt() },
          { role: 'user',   content: fullMd },
        ],
        stream: true,
        max_completion_tokens: profile?.maxTokens ?? 8192,
        temperature: profile?.temperature ?? 0.3,
      };
      if (profile?.reasoningEffort) requestBody.reasoning_effort = profile.reasoningEffort;
      if (profile?.extraBody) {
        try { Object.assign(requestBody, JSON.parse(profile.extraBody)); } catch { /* ignore invalid extraBody */ }
      }

      const resp = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify(requestBody),
      });

      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        setAiError(`Errore API ${resp.status}: ${txt.slice(0, 100)}`);
        return;
      }

      setView('edit');
      onBodyChange('');

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      const { ThinkTagFilter } = await import('../../../models/providers/openai-compatible');
      const thinkFilter = new ThinkTagFilter();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') break;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta;
            if (delta?.content && !delta?.reasoning_content) {
              // Silent think-tag filtering (Galene-style inline reasoning)
              const filtered = thinkFilter.push(delta.content);
              if (filtered.text) {
                accumulated += filtered.text;
                onBodyChange(accumulated);
              }
            }
          } catch { /* ignore malformed SSE lines */ }
        }
      }
      const rest = thinkFilter.flush();
      if (rest.text) {
        accumulated += rest.text;
        onBodyChange(accumulated);
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setAiImproving(false);
    }
  };

  const stepCount  = countSteps(body);
  const fullMarkdown = `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}`;

  const hdrBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4, height: 22,
    padding: '0 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.14)',
    background: 'transparent', color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
    fontSize: 10.5, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="skill-editor">
      <FloatingInput label={t('skills.editorTitle')} value={title} onChange={onTitleChange} data-testid="skill-editor-title" />
      <FloatingInput label={t('skills.editorDesc')}  value={description} onChange={onDescChange} data-testid="skill-editor-desc" />

      {/* ── Code block with toolbar ── */}
      <div style={{ background: 'var(--code-bg)', borderRadius: 8, border: '1px solid var(--border)', position: 'relative', overflow: 'visible' }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '5px 8px 5px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'rgba(255,255,255,0.45)' }}>
            markdown · body · {stepCount} step{stepCount !== 1 ? 's' : ''}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>

            {/* Tool dropdown trigger */}
            <div ref={dropdownRef} style={{ position: 'relative' }}>
              <button style={hdrBtn} onClick={() => setDropOpen(o => !o)} title="Inserisci tool o comando">
                <LucideIcon name="Wrench" size={11} />
                Tool
                <LucideIcon name="ChevronDown" size={10} />
              </button>

              {dropOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 200,
                  width: 340, maxHeight: 320, overflowY: 'auto',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                }}>
                  {/* Step commands section */}
                  <div style={{ padding: '8px 10px 4px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Comandi step
                  </div>
                  {STEP_COMMANDS.map(cmd => (
                    <DropItem
                      key={cmd}
                      name={cmd + ':'}
                      desc={STEP_COMMAND_DESCRIPTIONS[cmd]}
                      nameColor="var(--primary)"
                      nameWidth={90}
                      onClick={() => handleInsert(cmd, true)}
                    />
                  ))}

                  <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />

                  {/* Tool groups */}
                  {TOOL_GROUPS.map(group => (
                    <div key={group.label}>
                      <div style={{ padding: '6px 10px 2px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {group.label}
                      </div>
                      {group.tools.map(toolName => (
                        <DropItem
                          key={toolName}
                          name={toolName}
                          desc={(TOOL_DESCRIPTIONS_EN[toolName] ?? '').slice(0, 58) + ((TOOL_DESCRIPTIONS_EN[toolName] ?? '').length > 58 ? '…' : '')}
                          nameColor="var(--text)"
                          nameWidth={148}
                          onClick={() => handleInsert(toolName, false)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Preview toggle */}
            <button
              style={hdrBtn}
              onClick={() => setView(v => v === 'edit' ? 'preview' : 'edit')}
              title={view === 'edit' ? 'Mostra anteprima' : "Torna all'editor"}
            >
              <LucideIcon name={view === 'edit' ? 'Eye' : 'Code'} size={11} />
              {view === 'edit' ? 'Anteprima' : 'Editor'}
            </button>
          </div>
        </div>

        {/* Body area */}
        {view === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={body}
            onChange={e => onBodyChange(e.target.value)}
            placeholder={t('skills.bodyPlaceholder')}
            disabled={aiImproving}
            data-testid="skill-editor-body"
            style={{
              width: '100%', minHeight: 150, padding: '10px 14px',
              border: 0, outline: 'none', resize: 'vertical', boxSizing: 'border-box',
              fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55,
              color: aiImproving ? 'rgba(255,255,255,0.35)' : 'var(--code-fg)',
              background: 'transparent', transition: 'color .2s',
            }}
          />
        ) : (
          <div style={{ minHeight: 150, padding: '10px 16px', color: 'var(--text)', fontSize: 12.5, lineHeight: 1.6, background: 'var(--surface)' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {fullMarkdown}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Button
            variant="outline"
            icon={aiImproving ? 'Loader' : 'Sparkles'}
            onClick={handleImproveWithAI}
            disabled={aiImproving || !title.trim()}
          >
            {aiImproving ? 'Migliorando…' : 'Migliora con AI'}
          </Button>
          {aiError && (
            <span style={{ fontSize: 11.5, color: 'var(--error)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
              {aiError}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <Button variant="ghost" onClick={onCancel} data-testid="btn-cancel-skill">{t('skills.cancel')}</Button>
          <Button icon="Save" onClick={onSave} disabled={!title.trim()} data-testid="btn-save-skill">{t('skills.save')}</Button>
        </div>
      </div>
    </div>
  );
}

// ─── DropItem (shared row for dropdown) ──────────────────────────────────────

function DropItem({ name, desc, nameColor, nameWidth, onClick }: {
  name: string; desc: string; nameColor: string; nameWidth: number; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8, width: '100%',
        padding: '5px 12px', border: 0, cursor: 'pointer', textAlign: 'left',
        fontFamily: 'inherit', background: hover ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: nameColor, width: nameWidth, flexShrink: 0 }}>
        {name}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {desc}
      </span>
    </button>
  );
}

// ─── SkillsTab ────────────────────────────────────────────────────────────────

type EditorMode = 'new' | 'edit';

export function SkillsTab() {
  const { t } = useLang();
  const [skills, setSkills]               = useState<SkillDefinition[]>([]);
  const [editorOpen, setEditorOpen]       = useState(false);
  const [editorMode, setEditorMode]       = useState<EditorMode>('new');
  const [editorTitle, setEditorTitle]     = useState('');
  const [editorDescription, setEditorDescription] = useState('');
  const [editorBody, setEditorBody]       = useState('');
  const [originalTitle, setOriginalTitle] = useState('');
  const [importError, setImportError]     = useState('');
  const [runFeedback, setRunFeedback]     = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const list = await SkillManager.getInstance().listSkills();
    setSkills(list);
  };

  useEffect(() => { load(); }, []);

  const buildMarkdown = (title: string, desc: string, body: string) =>
    `---\ntitle: ${title}\ndescription: ${desc}\n---\n\n${body}`;

  const openNew = () => {
    setEditorMode('new'); setEditorTitle(''); setEditorDescription('');
    setEditorBody(''); setOriginalTitle(''); setEditorOpen(true);
  };

  const openEdit = (skill: SkillDefinition) => {
    setEditorMode('edit'); setEditorTitle(skill.title); setEditorDescription(skill.description);
    const bodyMatch = skill.raw.match(/^---[\s\S]*?---\n([\s\S]*)$/);
    setEditorBody(bodyMatch ? bodyMatch[1].trim() : '');
    setOriginalTitle(skill.title); setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!editorTitle.trim()) return;
    const md = buildMarkdown(editorTitle.trim(), editorDescription.trim(), editorBody);
    const manager = SkillManager.getInstance();
    if (editorMode === 'edit' && originalTitle && originalTitle !== editorTitle.trim()) {
      await manager.deleteSkill(originalTitle);
    }
    const skill = parseSkill(md);
    await manager.saveSkill(skill);
    setEditorOpen(false);
    await load();
  };

  const handleCancel = () => setEditorOpen(false);

  const handleRun = (title: string) => {
    chrome.runtime.sendMessage(
      { action: 'executeSkillPrompt', skillTitle: title },
      (response) => {
        const ok = !chrome.runtime.lastError && response?.success;
        setRunFeedback(prev => ({ ...prev, [title]: ok ? '✓ Avviato' : '⚠ Apri il pannello laterale' }));
        setTimeout(() => setRunFeedback(prev => { const n = { ...prev }; delete n[title]; return n; }), 2500);
      }
    );
  };

  const handleDelete = async (title: string) => {
    await SkillManager.getInstance().deleteSkill(title);
    await load();
  };

  const handleExport = (skill: SkillDefinition) => {
    const content = SkillManager.getInstance().exportToFile(skill);
    const blob = new Blob([content], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${skill.title.replace(/\s+/g, '-').toLowerCase()}.md`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError('');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        await SkillManager.getInstance().importFromFile(ev.target?.result as string);
        await load();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : String(err));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Section
        title={t('skills.title')}
        description={t('skills.desc')}
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="outline" size="sm" icon="Upload" onClick={() => fileInputRef.current?.click()} data-testid="btn-import-skill">
              {t('skills.import')}
            </Button>
            <Button size="sm" icon="Plus" onClick={openNew} data-testid="btn-new-skill">
              {t('skills.new')}
            </Button>
            <input ref={fileInputRef} type="file" accept=".md" style={{ display: 'none' }} onChange={handleImport} data-testid="skill-file-input" />
          </div>
        }
      >
        {importError && (
          <div style={{
            padding: '8px 12px', background: 'var(--error-soft)', border: '1px solid var(--error)',
            borderRadius: 8, fontSize: 12, color: 'var(--error)',
          }} data-testid="skill-import-error">{importError}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="skill-list">
          {skills.length === 0 && !editorOpen && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '16px 0' }} data-testid="skill-list-empty">
              {t('skills.empty')}
            </div>
          )}

          {skills.map((skill) => (
            <React.Fragment key={skill.title}>
              <div className="ia-card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }} data-testid={`skill-item-${skill.title}`}>
                <div style={{
                  width: 38, height: 38, borderRadius: 9, flex: '0 0 auto',
                  background: 'var(--primary-soft)', color: 'var(--primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <LucideIcon name="FileCode2" size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{skill.title}</span>
                    <Chip size="xs" tone="neutral">{skill.steps.length} steps</Chip>
                    {runFeedback[skill.title] && <Chip size="xs" tone="success">{runFeedback[skill.title]}</Chip>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{skill.description}</div>
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  <IconButton icon="Zap"      size="sm" title={t('skills.run')}    onClick={() => handleRun(skill.title)}    active data-testid={`btn-run-skill-${skill.title}`} />
                  <IconButton icon="Pencil"   size="sm" title={t('skills.edit')}   onClick={() => openEdit(skill)}           data-testid={`btn-edit-skill-${skill.title}`} />
                  <IconButton icon="Download" size="sm" title={t('skills.export')} onClick={() => handleExport(skill)}       data-testid={`btn-export-skill-${skill.title}`} />
                  <IconButton icon="Trash2"   size="sm" title={t('skills.delete')} onClick={() => handleDelete(skill.title)} danger data-testid={`btn-delete-skill-${skill.title}`} />
                </div>
              </div>

              {editorOpen && editorMode === 'edit' && editorTitle === skill.title && (
                <div className="ia-expand-in" style={{
                  border: '1.5px solid var(--primary)', borderRadius: 12, padding: 14,
                  background: 'var(--surface)',
                }} data-testid="skill-editor-container">
                  <SkillEditorPanel
                    title={editorTitle}
                    description={editorDescription}
                    body={editorBody}
                    onTitleChange={setEditorTitle}
                    onDescChange={setEditorDescription}
                    onBodyChange={setEditorBody}
                    onSave={handleSave}
                    onCancel={handleCancel}
                    t={t}
                  />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>

        {/* New skill editor */}
        {editorOpen && editorMode === 'new' && (
          <div className="ia-expand-in" style={{
            border: '1.5px solid var(--primary)', borderRadius: 12, padding: 14,
            background: 'var(--surface)',
          }} data-testid="skill-editor-container">
            <SkillEditorPanel
              title={editorTitle}
              description={editorDescription}
              body={editorBody}
              onTitleChange={setEditorTitle}
              onDescChange={setEditorDescription}
              onBodyChange={setEditorBody}
              onSave={handleSave}
              onCancel={handleCancel}
              t={t}
            />
          </div>
        )}
      </Section>
    </div>
  );
}

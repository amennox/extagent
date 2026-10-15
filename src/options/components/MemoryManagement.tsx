import React, { useRef, useState, useEffect } from 'react';
import { MemoryManager, Memory } from '../../agent/MemoryManager';
import { Button, Chip, IconButton, LucideIcon, EmptyState } from '../../ui';
import { Section } from './Section';

function formatDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'oggi';
  if (days === 1) return 'ieri';
  if (days < 7) return `${days} giorni fa`;
  if (days < 30) return `${Math.floor(days / 7)} sett. fa`;
  return `${Math.floor(days / 30)} mesi fa`;
}

export function MemoryManagement() {
  const [agentMemories, setAgentMemories] = useState<Memory[]>([]);
  const [importStatus, setImportStatus] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const agentImportRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const manager = new MemoryManager([]);
    const all: Memory[] = JSON.parse(await manager.exportMemories() || '[]');
    setAgentMemories(all);
  };

  useEffect(() => { load(); }, []);

  const handleValidate = async (id: string) => {
    const manager = new MemoryManager([]);
    await manager.markValidated(id);
    await load();
  };

  const handleDelete = async (id: string) => {
    const manager = new MemoryManager([]);
    await manager.deleteMemory(id);
    await load();
  };

  const openEdit = (m: Memory) => { setEditingId(m.id); setEditText(m.pattern); };
  const cancelEdit = () => { setEditingId(null); setEditText(''); };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const manager = new MemoryManager([]);
    await manager.updateMemoryPattern(editingId, editText);
    cancelEdit();
    await load();
  };

  const handleExport = async () => {
    const manager = new MemoryManager([]);
    const json = await manager.exportMemories();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-memories-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const manager = new MemoryManager([]);
        const count = await manager.importMemories(ev.target?.result as string);
        await load();
        setImportStatus(`${count} memorie importate`);
        setTimeout(() => setImportStatus(''), 3000);
      } catch {
        setImportStatus('Errore: formato non valido');
        setTimeout(() => setImportStatus(''), 3000);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const validated = agentMemories.filter(m => m.validated).length;
  const pending = agentMemories.filter(m => !m.validated).length;

  return (
    <Section
      title="Memorie a lungo termine"
      description="Fatti che l'agente ricorda tra una sessione e l'altra."
      action={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outline" size="sm" icon="Download" onClick={handleExport} disabled={agentMemories.length === 0}>
            Export
          </Button>
          <Button variant="outline" size="sm" icon="Upload" onClick={() => agentImportRef.current?.click()}>
            Import
          </Button>
          <input ref={agentImportRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
        </div>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Chip tone="primary" icon="BrainCircuit">{agentMemories.length} memorie salvate</Chip>
        <Chip tone="success" dot>{validated} validate</Chip>
        <Chip tone="warning" dot>{pending} da rivedere</Chip>
      </div>

      {importStatus && (
        <div style={{ fontSize: 12, color: 'var(--success)', padding: '4px 0' }}>{importStatus}</div>
      )}

      {agentMemories.length === 0 ? (
        <EmptyState
          icon="BrainCircuit"
          title="Nessuna memoria"
          description="L'agente apprende automaticamente durante le sessioni."
        />
      ) : (
        <div className="ia-card" style={{ overflow: 'hidden' }}>
          {agentMemories.map((m, i) => (
            <React.Fragment key={m.id}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                borderBottom: i < agentMemories.length - 1 && editingId !== m.id
                  ? '1px solid var(--border)' : 'none',
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 8, flex: '0 0 auto',
                  background: m.validated ? 'var(--success-soft)' : 'var(--warning-soft)',
                  color: m.validated ? 'var(--success)' : 'var(--warning)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <LucideIcon name={m.validated ? 'CheckCircle2' : 'AlertCircle'} size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12.5, color: 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{m.pattern}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    {m.domain} · {formatDate(m.createdAt)} · {m.validated ? 'validata' : 'pending'}
                  </div>
                </div>
                {!m.validated && <Chip size="xs" tone="warning">da validare</Chip>}
                <div style={{ display: 'flex', gap: 2 }}>
                  {!m.validated && (
                    <IconButton icon="Check" size="sm" title="Valida" onClick={() => handleValidate(m.id)} data-testid={`btn-validate-${m.id}`} />
                  )}
                  <IconButton icon="Pencil" size="sm" title="Modifica" onClick={() => openEdit(m)} data-testid={`btn-edit-memory-${m.id}`} />
                  <IconButton icon="Trash2" size="sm" title="Elimina" danger onClick={() => handleDelete(m.id)} data-testid={`btn-delete-memory-${m.id}`} />
                </div>
              </div>

              {editingId === m.id && (
                <div className="ia-expand-in" style={{
                  padding: '0 14px 14px',
                  borderBottom: i < agentMemories.length - 1 ? '1px solid var(--border)' : 'none',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    rows={3}
                    style={{
                      width: '100%', padding: '8px 10px', border: '1px solid var(--border)',
                      borderRadius: 6, outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                      fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5,
                      background: 'var(--surface-2)', color: 'var(--text)',
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>Annulla</Button>
                    <Button size="sm" icon="Save" onClick={handleSaveEdit} disabled={!editText.trim()}>Salva</Button>
                  </div>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </Section>
  );
}

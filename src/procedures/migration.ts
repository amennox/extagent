import { buildProcedure, CapturedAction } from './builder';
import { ProcedureStore } from './store';
import { newId, Procedure, ProcedureStep } from './types';

const FLAG = 'proceduresMigrated';

interface LegacyRecording {
  name: string;
  description?: string;
  createdAt?: string;
  steps: CapturedAction[];
}

interface LegacySkillStep {
  type: 'navigate' | 'extract' | 'paginate' | 'fill' | 'play' | 'export' | 'compute';
  payload: string;
  saveAs?: string;
}

interface LegacySkill {
  title: string;
  description?: string;
  params?: string[];
  steps?: LegacySkillStep[];
  notes?: string[];
}

function aiStep(instruction: string, description: string, saveAs?: string): ProcedureStep {
  return { id: newId('s_'), type: 'ai', description, instruction, saveAs, approval: 'auto' };
}

/**
 * One-time migration of the legacy "recordings" and "skills" into
 * procedures. Legacy data is left in storage untouched (non destructive).
 * Auto-generated recordings ("auto: …") are not migrated.
 */
export async function migrateLegacyAutomations(): Promise<number> {
  const flags = await chrome.storage.local.get([FLAG, 'recordings', 'skills']);
  if (flags?.[FLAG]) return 0;
  const recordings = (flags?.recordings ?? {}) as Record<string, LegacyRecording>;
  const skills = (flags?.skills ?? {}) as Record<string, LegacySkill>;
  const store = ProcedureStore.getInstance();
  const usedBySkills = new Set<string>();
  const created: Procedure[] = [];

  for (const skill of Object.values(skills)) {
    if (!skill?.title) continue;
    const steps: ProcedureStep[] = [];
    let base: Procedure | null = null;
    for (const s of skill.steps ?? []) {
      switch (s.type) {
        case 'play': {
          const rec = recordings[s.payload.replace(/\s+with\s+\{[\s\S]*\}$/i, '').trim()];
          if (rec) {
            usedBySkills.add(rec.name);
            const p = buildProcedure(rec.steps ?? [], { name: skill.title, source: 'migration' });
            base = base ?? p;
            steps.push(...p.steps);
          } else {
            steps.push(aiStep(`Esegui la sequenza "${s.payload}" (registrazione non trovata)`, `Sequenza ${s.payload}`));
          }
          break;
        }
        case 'navigate':
          steps.push({ id: newId('s_'), type: 'navigate', description: `Apri ${s.payload}`, value: s.payload, approval: 'auto' });
          break;
        case 'extract': {
          let schema: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(s.payload);
            schema = parsed?.schema ?? parsed;
          } catch { /* keep as ai step */ }
          steps.push(schema
            ? { id: newId('s_'), type: 'extract', description: 'Estrai dati', schema, saveAs: s.saveAs, approval: 'auto' }
            : aiStep(`Estrai: ${s.payload}`, 'Estrai dati', s.saveAs));
          break;
        }
        case 'compute':
          steps.push(aiStep(s.payload, 'Calcola un valore', s.saveAs));
          break;
        case 'paginate':
          steps.push(aiStep(`Raccogli i dati su tutte le pagine della lista: ${s.payload}`, 'Raccolta multi-pagina', s.saveAs));
          break;
        case 'fill':
          steps.push(aiStep(`Compila il form con questi dati (senza inviare): ${s.payload}`, 'Compila il form'));
          break;
        case 'export':
          break;
      }
    }
    if (!steps.length && skill.notes?.length) {
      steps.push(aiStep(skill.notes.join('\n'), 'Istruzioni della skill'));
    }
    if (!steps.length) continue;
    const proc: Procedure = {
      ...(base ?? buildProcedure([], { name: skill.title, source: 'migration' })),
      id: newId('p_'),
      name: skill.title,
      description: skill.description ?? '',
      steps,
      notes: skill.notes?.join('\n'),
      source: 'migration',
    };
    const declared = new Set(proc.params.map(p => p.name));
    for (const name of skill.params ?? []) {
      if (!declared.has(name)) proc.params.push({ name, type: 'text', required: true });
    }
    created.push(proc);
  }

  for (const rec of Object.values(recordings)) {
    if (!rec?.name || usedBySkills.has(rec.name) || rec.name.startsWith('auto:')) continue;
    if (!rec.steps?.length) continue;
    created.push(buildProcedure(rec.steps, { name: rec.name, description: rec.description, source: 'migration' }));
  }

  for (const p of created) await store.save(p);
  await chrome.storage.local.set({ [FLAG]: true });
  return created.length;
}

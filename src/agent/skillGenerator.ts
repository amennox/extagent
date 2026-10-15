import { Recording, RecordingStep } from '../background/recordingManager';

/**
 * Skill generator — turns a recorded sequence into a reusable skill.md.
 *
 * Flow: findVariableCandidates() proposes what could become variable
 * (heuristic), buildAnalysisPrompt()/parseAnalysisResponse() optionally refine
 * names and description with one LLM call, the wizard collects the operator's
 * fixed/param/expression/AI choices, generateSkill() produces the markdown
 * plus the parametrized copy of the recording.
 */

export interface VariableCandidate {
  /** Index of the step in recording.steps */
  stepIndex: number;
  recordedValue: string;
  fieldLabel?: string;
  suggestedName: string;
  stepType: RecordingStep['type'];
}

export type VariableChoiceType = 'fixed' | 'param' | 'expression' | 'ai';

export interface VariableChoice {
  stepIndex: number;
  type: VariableChoiceType;
  /** For 'param': parameter name; for 'ai': variable name filled by compute */
  name?: string;
  /** For 'expression': expression body, e.g. "oggi:GG/MM/AAAA" */
  expression?: string;
  /** For 'ai': natural-language instruction for the compute step */
  aiInstruction?: string;
}

export interface SkillMeta {
  title: string;
  description: string;
  notes?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'valore';
}

/** Heuristic variable candidates: every typed text and selected value. */
export function findVariableCandidates(recording: Recording): VariableCandidate[] {
  const candidates: VariableCandidate[] = [];
  const usedNames = new Set<string>();

  recording.steps.forEach((step, index) => {
    if ((step.type === 'type' || step.type === 'select') && step.text) {
      const name = slugify(step.elementLabel ?? step.elementText ?? `campo_${index + 1}`);
      let unique = name;
      let n = 2;
      while (usedNames.has(unique)) unique = `${name}_${n++}`;
      usedNames.add(unique);
      candidates.push({
        stepIndex: index,
        recordedValue: step.text,
        fieldLabel: step.elementLabel ?? step.elementText,
        suggestedName: unique,
        stepType: step.type,
      });
    }
  });

  return candidates;
}

/** One-call LLM prompt to refine title/description/variable names. */
export function buildAnalysisPrompt(recording: Recording, lang: 'it' | 'en' = 'it'): string {
  const steps = recording.steps
    .map((s, i) => `${i + 1}. [${s.type}] ${s.description ?? ''} ${s.elementLabel ? `(campo: ${s.elementLabel})` : ''} ${s.text ? `valore: "${s.text}"` : ''} ${s.url ?? ''}`.trim())
    .join('\n');

  const instructions = lang === 'it'
    ? `Analizza questa sequenza di azioni registrata su un portale web. Rispondi SOLO con JSON valido, nessun altro testo, nel formato:
{"title": "nome breve della procedura", "description": "cosa fa, una frase", "variables": [{"stepIndex": <indice 0-based dello step>, "name": "nome_parametro_snake_case", "reason": "perché dovrebbe essere variabile"}]}
Considera come possibili variabili: testi digitati, valori selezionati, termini di ricerca, date. NON includere password o dati sensibili.`
    : `Analyze this recorded action sequence on a web portal. Reply ONLY with valid JSON, no other text, format:
{"title": "short procedure name", "description": "what it does, one sentence", "variables": [{"stepIndex": <0-based step index>, "name": "snake_case_param_name", "reason": "why it should be variable"}]}
Candidate variables: typed texts, selected values, search terms, dates. Do NOT include passwords or sensitive data.`;

  return `${instructions}\n\nRegistrazione "${recording.name}"${recording.description ? ` — ${recording.description}` : ''}:\n${steps}`;
}

export interface AnalysisResult {
  title?: string;
  description?: string;
  variables?: Array<{ stepIndex: number; name: string; reason?: string }>;
}

/** Tolerant parse of the LLM analysis response. */
export function parseAnalysisResponse(raw: string): AnalysisResult | null {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```(?:json)?\n?/im, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  // Find the first JSON object in the text
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      variables: Array.isArray(parsed.variables)
        ? parsed.variables.filter((v: any) => typeof v?.stepIndex === 'number' && typeof v?.name === 'string')
        : undefined,
    };
  } catch {
    return null;
  }
}

export interface GeneratedSkill {
  markdown: string;
  /** Copy of the recording with chosen values replaced by {{…}} placeholders */
  updatedRecording: Recording;
  params: string[];
}

/**
 * Generate the skill.md and the parametrized recording from the operator's
 * choices. Values chosen as:
 * - fixed      → left as recorded
 * - param      → replaced by {{name}} (declared in frontmatter params)
 * - expression → replaced by {{expression}} (resolved at replay time, no LLM)
 * - ai         → replaced by {{name}} + a `compute:` step added before play
 */
export function generateSkill(
  recording: Recording,
  meta: SkillMeta,
  choices: VariableChoice[]
): GeneratedSkill {
  const updatedSteps: RecordingStep[] = recording.steps.map(s => ({ ...s }));
  const params: string[] = [];
  const computeLines: string[] = [];

  for (const choice of choices) {
    const step = updatedSteps[choice.stepIndex];
    if (!step) continue;
    switch (choice.type) {
      case 'fixed':
        break;
      case 'param': {
        const name = choice.name ?? `param_${choice.stepIndex + 1}`;
        step.text = `{{${name}}}`;
        if (!params.includes(name)) params.push(name);
        break;
      }
      case 'expression': {
        if (choice.expression) step.text = `{{${choice.expression}}}`;
        break;
      }
      case 'ai': {
        const name = choice.name ?? `valore_${choice.stepIndex + 1}`;
        step.text = `{{${name}}}`;
        if (choice.aiInstruction) {
          computeLines.push(`\`compute: ${choice.aiInstruction.replace(/`/g, "'")}\` → salva in {{${name}}}`);
        }
        break;
      }
    }
  }

  const updatedRecording: Recording = { ...recording, steps: updatedSteps };

  const frontmatter = [
    '---',
    `title: ${meta.title}`,
    `description: ${meta.description}`,
    ...(params.length ? [`params: [${params.join(', ')}]`] : []),
    '---',
  ].join('\n');

  const bodyLines: string[] = ['', '## Passi', ''];
  let n = 1;
  for (const line of computeLines) {
    bodyLines.push(`${n++}. ${line}`);
  }
  bodyLines.push(`${n++}. \`play: ${recording.name}\``);
  if (meta.notes?.trim()) {
    bodyLines.push('', '## Note operative', '');
    for (const noteLine of meta.notes.trim().split('\n')) {
      bodyLines.push(noteLine.trim());
    }
  }

  return {
    markdown: `${frontmatter}\n${bodyLines.join('\n')}\n`,
    updatedRecording,
    params,
  };
}

import {
  findVariableCandidates,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  generateSkill,
} from '../../../src/agent/skillGenerator';
import { parseSkill } from '../../../src/agent/skillManager';
import { Recording } from '../../../src/background/recordingManager';

const recording: Recording = {
  name: 'ricerca-fornitore',
  description: 'Cerca un fornitore nel gestionale',
  createdAt: '2026-07-07T10:00:00.000Z',
  steps: [
    { type: 'navigate', url: 'https://gestionale.example.it/fornitori' },
    { type: 'click', selector: '#search-tab', elementText: 'Ricerca' },
    { type: 'type', selector: '[name="q"]', text: 'Rossi SRL', elementLabel: 'Ragione sociale' },
    { type: 'type', selector: '[name="data"]', text: '01/07/2026', elementLabel: 'Data da' },
    { type: 'press', selector: '[name="q"]', text: 'Enter' },
  ],
};

describe('findVariableCandidates', () => {
  it('propone come candidati i testi digitati e i valori selezionati', () => {
    const candidates = findVariableCandidates(recording);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].recordedValue).toBe('Rossi SRL');
    expect(candidates[0].suggestedName).toBe('ragione_sociale');
    expect(candidates[1].recordedValue).toBe('01/07/2026');
  });

  it('genera nomi univoci in caso di label duplicate', () => {
    const rec: Recording = {
      ...recording,
      steps: [
        { type: 'type', selector: '#a', text: 'x', elementLabel: 'Campo' },
        { type: 'type', selector: '#b', text: 'y', elementLabel: 'Campo' },
      ],
    };
    const candidates = findVariableCandidates(rec);
    expect(candidates[0].suggestedName).not.toBe(candidates[1].suggestedName);
  });
});

describe('buildAnalysisPrompt / parseAnalysisResponse', () => {
  it('il prompt include i passi e chiede JSON', () => {
    const prompt = buildAnalysisPrompt(recording, 'it');
    expect(prompt).toContain('Rossi SRL');
    expect(prompt).toContain('JSON');
  });

  it('parse tollerante: JSON puro', () => {
    const result = parseAnalysisResponse('{"title":"Ricerca fornitore","description":"desc","variables":[{"stepIndex":2,"name":"ragione_sociale"}]}');
    expect(result?.title).toBe('Ricerca fornitore');
    expect(result?.variables?.[0].name).toBe('ragione_sociale');
  });

  it('parse tollerante: JSON dentro code fence con testo attorno', () => {
    const raw = 'Ecco:\n```json\n{"title":"T","description":"D","variables":[]}\n```\ngrazie';
    const result = parseAnalysisResponse(raw);
    expect(result?.title).toBe('T');
  });

  it('parse tollerante: rimuove blocchi think', () => {
    const raw = '<think>ragiono</think>{"title":"T","description":"D"}';
    expect(parseAnalysisResponse(raw)?.title).toBe('T');
  });

  it('ritorna null per risposte non JSON', () => {
    expect(parseAnalysisResponse('non so rispondere')).toBeNull();
  });
});

describe('generateSkill', () => {
  it('genera markdown con frontmatter, params e play', () => {
    const { markdown, params } = generateSkill(recording,
      { title: 'Ricerca fornitore', description: 'Cerca per ragione sociale' },
      [{ stepIndex: 2, type: 'param', name: 'ragione_sociale' }]
    );

    expect(params).toEqual(['ragione_sociale']);
    expect(markdown).toContain('title: Ricerca fornitore');
    expect(markdown).toContain('params: [ragione_sociale]');
    expect(markdown).toContain('`play: ricerca-fornitore`');
  });

  it('il markdown generato è parsabile da parseSkill', () => {
    const { markdown } = generateSkill(recording,
      { title: 'Ricerca fornitore', description: 'desc', notes: 'Se compare il popup, chiudilo.' },
      [
        { stepIndex: 2, type: 'param', name: 'ragione_sociale' },
        { stepIndex: 3, type: 'ai', name: 'data_inizio', aiInstruction: 'calcola il primo giorno del mese corrente' },
      ]
    );
    const skill = parseSkill(markdown);
    expect(skill.title).toBe('Ricerca fornitore');
    expect(skill.params).toEqual(['ragione_sociale']);
    const types = skill.steps.map(s => s.type);
    expect(types).toEqual(['compute', 'play']);
    expect(skill.steps[0].saveAs).toBe('data_inizio');
    expect(skill.notes?.join(' ')).toContain('popup');
  });

  it('sostituisce i valori scelti con i placeholder nella registrazione', () => {
    const { updatedRecording } = generateSkill(recording,
      { title: 'T', description: 'D' },
      [
        { stepIndex: 2, type: 'param', name: 'ragione_sociale' },
        { stepIndex: 3, type: 'expression', expression: 'oggi:GG/MM/AAAA' },
      ]
    );
    expect(updatedRecording.steps[2].text).toBe('{{ragione_sociale}}');
    expect(updatedRecording.steps[3].text).toBe('{{oggi:GG/MM/AAAA}}');
    // Fixed steps untouched
    expect(updatedRecording.steps[4].text).toBe('Enter');
  });

  it('scelta fixed lascia il valore registrato', () => {
    const { updatedRecording, params } = generateSkill(recording,
      { title: 'T', description: 'D' },
      [{ stepIndex: 2, type: 'fixed' }]
    );
    expect(updatedRecording.steps[2].text).toBe('Rossi SRL');
    expect(params).toEqual([]);
  });
});

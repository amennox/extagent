interface UseQuickActionsProps {
  executePrompt: (prompt: string) => Promise<void>;
}

export function useQuickActions({ executePrompt }: UseQuickActionsProps) {
  const startSmartPaste = async (text: string): Promise<void> => {
    const prompt =
      `Leggi i campi compilabili di questa pagina. ` +
      `Poi, dato il seguente testo: "${text}", ` +
      `cerca di associare le informazioni ai campi e compilali. ` +
      `Usa il tool fill_form_from_data.`;
    await executePrompt(prompt);
  };

  const startSmartExtract = async (hint: string, format: string, paginate: boolean): Promise<void> => {
    const input: Record<string, unknown> = { hint, format };
    const prompt =
      `Estrai i dati strutturati dalla pagina corrente usando il tool smart_extract_data.\n` +
      `Chiama il tool con questo formato esatto:\n` +
      `<tool>smart_extract_data</tool>\n` +
      `<input>${JSON.stringify(input)}</input>\n` +
      `<requires_approval>false</requires_approval>\n` +
      (paginate ? 'Se la pagina ha paginazione, l\'estrazione deve concentrarsi sulla pagina visibile; per raccogliere più pagine usa in seguito paginate_and_collect.' : '');
    await executePrompt(prompt);
  };

  return { startSmartPaste, startSmartExtract };
}

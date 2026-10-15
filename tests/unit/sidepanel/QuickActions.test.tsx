import { jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock useLang to return a simple t() function
jest.mock('../../../src/i18n', () => ({
  useLang: () => ({ t: (key: string) => key, lang: 'it' }),
}));

// Mock useQuickActions
const mockStartSmartPaste = jest.fn().mockResolvedValue(undefined);
const mockStartSmartExtract = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../src/sidepanel/hooks/useQuickActions', () => ({
  useQuickActions: () => ({
    startSmartPaste: mockStartSmartPaste,
    startSmartExtract: mockStartSmartExtract,
  }),
}));

// Import components after mocks
import { QuickActions } from '../../../src/sidepanel/components/QuickActions';
import { SmartPastePanel } from '../../../src/sidepanel/components/SmartPastePanel';
import { SmartExtractPanel } from '../../../src/sidepanel/components/SmartExtractPanel';

const mockExecutePrompt = jest.fn().mockResolvedValue(undefined);

// ─────────────────────────────────────────────────────────────────────────────

describe('QuickActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mostra tre bottoni: Smart Paste, Smart Extract, Automate', () => {
    render(<QuickActions executePrompt={mockExecutePrompt} isProcessing={false} />);

    expect(screen.getByTestId('btn-smart-paste')).toBeInTheDocument();
    expect(screen.getByTestId('btn-smart-extract')).toBeInTheDocument();
    expect(screen.getByTestId('btn-automate')).toBeInTheDocument();
  });

  it('click Smart Paste apre SmartPastePanel', () => {
    render(<QuickActions executePrompt={mockExecutePrompt} isProcessing={false} />);

    expect(screen.queryByTestId('smart-paste-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('btn-smart-paste'));

    expect(screen.getByTestId('smart-paste-panel')).toBeInTheDocument();
  });

  it('click Smart Extract apre SmartExtractPanel', () => {
    render(<QuickActions executePrompt={mockExecutePrompt} isProcessing={false} />);

    fireEvent.click(screen.getByTestId('btn-smart-extract'));

    expect(screen.getByTestId('smart-extract-format')).toBeInTheDocument();
    expect(screen.getByTestId('smart-extract-submit')).toBeInTheDocument();
  });

  it('click Automate apre RecordingPanel', () => {
    render(<QuickActions executePrompt={mockExecutePrompt} isProcessing={false} />);

    expect(screen.queryByTestId('recording-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('btn-automate'));

    expect(screen.getByTestId('recording-panel')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('SmartPastePanel', () => {
  const mockOnSubmit = jest.fn().mockResolvedValue(undefined);
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disabilita bottone Compila se textarea è vuota', () => {
    render(<SmartPastePanel onSubmit={mockOnSubmit} onClose={mockOnClose} />);

    const btn = screen.getByTestId('smart-paste-submit');
    expect(btn).toBeDisabled();
  });

  it('chiama startSmartPaste con il testo inserito', async () => {
    render(<SmartPastePanel onSubmit={mockOnSubmit} onClose={mockOnClose} />);

    const textarea = screen.getByTestId('smart-paste-textarea');
    fireEvent.change(textarea, { target: { value: 'Nome: Acme Srl, P.IVA: 12345678901' } });

    const btn = screen.getByTestId('smart-paste-submit');
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith('Nome: Acme Srl, P.IVA: 12345678901');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('SmartExtractPanel', () => {
  const mockOnExtract = jest.fn().mockResolvedValue(undefined);
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mostra le opzioni di estrazione', () => {
    render(<SmartExtractPanel onExtract={mockOnExtract} onClose={mockOnClose} />);

    expect(screen.getByTestId('smart-extract-format')).toBeInTheDocument();
    expect(screen.getByTestId('smart-extract-paginate')).toBeInTheDocument();
    expect(screen.getByTestId('smart-extract-hint')).toBeInTheDocument();
    expect(screen.getByTestId('smart-extract-submit')).toBeInTheDocument();
  });

  it('il dropdown formato ha le opzioni JSON, CSV', () => {
    render(<SmartExtractPanel onExtract={mockOnExtract} onClose={mockOnClose} />);

    const select = screen.getByTestId('smart-extract-format') as HTMLSelectElement;
    const options = Array.from(select.options).map(o => o.value);
    expect(options).toContain('json');
    expect(options).toContain('csv');
  });

  it('bottone Estrai chiama startSmartExtract con hint, formato e paginate', async () => {
    render(<SmartExtractPanel onExtract={mockOnExtract} onClose={mockOnClose} />);

    fireEvent.change(screen.getByTestId('smart-extract-format'), { target: { value: 'csv' } });
    fireEvent.click(screen.getByTestId('smart-extract-paginate'));
    fireEvent.change(screen.getByTestId('smart-extract-hint'), { target: { value: 'solo titoli' } });

    fireEvent.click(screen.getByTestId('smart-extract-submit'));

    await waitFor(() => {
      expect(mockOnExtract).toHaveBeenCalledWith('solo titoli', 'csv', true);
    });
  });
});

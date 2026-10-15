import React from 'react';
import { Chip, IconButton } from '../../ui';

interface OutputHeaderProps {
  onClearHistory: () => void;
  onReflectAndLearn: () => void;
  onExportLog?: () => void;
  isProcessing: boolean;
  messageCount?: number;
}

export const OutputHeader: React.FC<OutputHeaderProps> = ({
  onClearHistory,
  onReflectAndLearn,
  onExportLog,
  messageCount = 0,
}) => {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px 6px', flex: '0 0 auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Output</span>
        <Chip size="xs" tone="neutral">{messageCount} messages</Chip>
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {onExportLog && (
          <IconButton icon="FileDown" size="sm" title="Esporta log sessione" onClick={onExportLog} />
        )}
        <IconButton icon="BrainCircuit" size="sm" title="Reflect & learn" onClick={onReflectAndLearn} />
        <IconButton icon="Trash2" size="sm" title="Clear output" onClick={onClearHistory} />
      </div>
    </div>
  );
};

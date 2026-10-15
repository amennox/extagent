import React, { useState } from 'react';
import { useLang } from '../../i18n';
import { isHomogeneousArray, toCSV, downloadCSV, downloadJSON } from '../../utils/csvExport';

interface ExportBarProps {
  result: unknown;
  filename?: string;
}

export function ExportBar({ result, filename = 'export' }: ExportBarProps) {
  const { t } = useLang();
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedTsv, setCopiedTsv] = useState(false);

  const handleCopyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1500);
  };

  const handleDownloadJson = () => {
    downloadJSON(result, `${filename}.json`);
  };

  const handleExportCSV = () => {
    if (!isHomogeneousArray(result)) return;
    downloadCSV(toCSV(result as object[]), `${filename}.csv`);
  };

  const handleCopyTable = async () => {
    if (!isHomogeneousArray(result)) return;
    const tsv = toCSV(result as object[], '\t').slice(1); // strip BOM
    await navigator.clipboard.writeText(tsv);
    setCopiedTsv(true);
    setTimeout(() => setCopiedTsv(false), 1500);
  };

  return (
    <div className="flex gap-2 mt-2 flex-wrap" data-testid="export-bar">
      <button
        className="btn btn-xs btn-outline"
        onClick={handleCopyJson}
        data-testid="btn-copy-json"
      >
        {copiedJson ? '✓' : t('output.copyJson')}
      </button>
      <button
        className="btn btn-xs btn-outline"
        onClick={handleDownloadJson}
        data-testid="btn-download-json"
      >
        {t('output.downloadJson')}
      </button>
      {isHomogeneousArray(result) && (
        <>
          <button
            className="btn btn-xs btn-outline"
            onClick={handleExportCSV}
            data-testid="btn-export-csv"
          >
            {t('output.exportCsv')}
          </button>
          <button
            className="btn btn-xs btn-outline"
            onClick={handleCopyTable}
            data-testid="btn-copy-table"
          >
            {copiedTsv ? '✓' : t('output.copyTable')}
          </button>
        </>
      )}
    </div>
  );
}

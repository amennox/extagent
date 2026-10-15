import React, { useState, useEffect, useRef } from 'react';
import { ConfigManager } from '../background/configManager';
import { useLang } from '../i18n';
import { TokenTrackingService } from '../tracking/tokenTrackingService';
import { EmptyState, Button, IconButton } from '../ui';
import { ApprovalRequest } from './components/ApprovalRequest';
import { FeedbackChips } from './components/FeedbackChips';
import { MessageDisplay } from './components/MessageDisplay';
import { PromptForm } from './components/PromptForm';
import { QuickActions } from './components/QuickActions';
import { SPHeader } from './components/SPHeader';
import { TaskHistory } from './components/TaskHistory';
import { useChromeMessaging } from './hooks/useChromeMessaging';
import { useMessageManagement } from './hooks/useMessageManagement';
import { useTabManagement } from './hooks/useTabManagement';
import { useTaskHistory } from './hooks/useTaskHistory';

export function SidePanel() {
  const { t } = useLang();

  const [tabStatus, setTabStatus] = useState<'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error'>('unknown');
  const [activeTab, setActiveTab] = useState<'output' | 'history'>('output');

  const [approvalRequests, setApprovalRequests] = useState<Array<{
    requestId: string;
    toolName: string;
    toolInput: string;
    reason: string;
  }>>([]);

  const [currentAction, setCurrentAction] = useState<string>('');
  const [showFeedback, setShowFeedback] = useState(false);

  const pendingRef = useRef<string[]>([]);

  const [hasConfiguredProviders, setHasConfiguredProviders] = useState<boolean>(false);

  useEffect(() => {
    const checkProviders = async () => {
      const configManager = ConfigManager.getInstance();
      const providers = await configManager.getConfiguredProviders();
      setHasConfiguredProviders(providers.length > 0);
    };

    checkProviders();

    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'sync' && (
        'openaiCompatibleApiKey' in changes ||
        'openaiCompatibleBaseUrl' in changes ||
        'modelProfiles' in changes
      )) {
        checkProviders();
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    const handleMessage = (message: any) => {
      if (message.action === 'providerConfigChanged') {
        checkProviders();
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const {
    tabId,
    windowId,
    tabTitle,
    setTabTitle,
  } = useTabManagement();

  const {
    messages,
    streamingSegments,
    isStreaming,
    isProcessing,
    setIsProcessing,
    outputRef,
    addMessage,
    addSystemMessage,
    updateStreamingChunk,
    finalizeStreamingSegment,
    startNewSegment,
    completeStreaming,
    clearMessages,
  } = useMessageManagement();

  const { history: taskHistory, addTask, clearHistory: clearTaskHistory } = useTaskHistory();

  useEffect(() => {
    if (!isProcessing) return;
    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ action: 'checkAgentStatus', tabId, windowId });
    }, 2000);
    return () => clearInterval(interval);
  }, [isProcessing, tabId, windowId]);

  const handleApprove = (requestId: string) => {
    approveRequest(requestId);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`✅ ${t('approval.approved')}: ${requestId}`);
  };

  const handleReject = (requestId: string) => {
    rejectRequest(requestId);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`❌ ${t('approval.rejected')}: ${requestId}`);
  };

  const {
    executePrompt,
    cancelExecution,
    clearHistory,
    approveRequest,
    rejectRequest,
  } = useChromeMessaging({
    tabId,
    windowId,
    onUpdateOutput: (content) => {
      const msg: Parameters<typeof addMessage>[0] = { ...content, isComplete: true };
      if (content.type === 'llm') {
        try {
          msg.structuredResult = JSON.parse(content.content);
        } catch {
          // not JSON
        }
      }
      if (content.type === 'system' && typeof content.content === 'string' && content.content.includes('tool:')) {
        const toolMatch = content.content.match(/tool:\s*(\S+)/);
        if (toolMatch) setCurrentAction(toolMatch[1]);
      }
      addMessage(msg);
    },
    onUpdateStreamingChunk: (content) => updateStreamingChunk(content.content),
    onFinalizeStreamingSegment: (id, content) => finalizeStreamingSegment(id, content),
    onStartNewSegment: (id) => startNewSegment(id),
    onStreamingComplete: () => completeStreaming(),
    onUpdateLlmOutput: (content) => addMessage({ type: 'llm', content, isComplete: true }),
    onRateLimit: () => {
      addSystemMessage(t('error.rateLimit'));
      setIsProcessing(true);
      setTabStatus('running');
    },
    onFallbackStarted: (message) => {
      addSystemMessage(message);
      setIsProcessing(true);
      setTabStatus('running');
    },
    onUpdateScreenshot: (content) => addMessage({ ...content, isComplete: true }),
    onProcessingComplete: () => {
      setIsProcessing(false);
      completeStreaming();
      setTabStatus('idle');
      setCurrentAction('');
    },
    onRequestApproval: (request) => setApprovalRequests(prev => [...prev, request]),
    setTabTitle,
    onTabStatusChanged: (status) => setTabStatus(status),
    onTargetChanged: () => {},
    onActiveTabChanged: (_oldTabId, _newTabId, title, url) => {
      setTabTitle(title);
      addSystemMessage(`${t('tab.switched')}: ${title} (${url})`);
    },
    onPageDialog: (_tabId, dialogInfo) => {
      addSystemMessage(`${t('tab.dialog')}: ${dialogInfo.type} - ${dialogInfo.message}`);
    },
    onPageError: (_tabId, error) => {
      addSystemMessage(`${t('tab.pageError')}: ${error}`);
    },
    onAgentStatusUpdate: (status) => {
      if (status === 'running' || status === 'idle' || status === 'error') {
        setTabStatus(status);
      }
      if (status === 'running') setIsProcessing(true);
      if (status === 'idle') setIsProcessing(false);
    },
    onTaskOutcome: (outcome) => {
      // Ask for feedback only on tasks that actually ran to an end state
      setShowFeedback(outcome === 'success' || outcome === 'failure');
    },
  });

  const runPrompt = async (prompt: string) => {
    addTask(prompt);
    setShowFeedback(false);
    setIsProcessing(true);
    setTabStatus('running');
    setActiveTab('output');
    addSystemMessage(`${t('sidepanel.newPrompt')}: "${prompt}"`);

    try {
      await executePrompt(prompt);
    } catch (error) {
      console.error('Error:', error);
      addSystemMessage('Error: ' + (error instanceof Error ? error.message : String(error)));
      setIsProcessing(false);
      setTabStatus('error');
    }
  };

  const handleSubmit = async (prompt: string) => {
    if (isProcessing) {
      pendingRef.current.push(prompt);
      addSystemMessage(t('sidepanel.queued'));
      return;
    }
    await runPrompt(prompt);
  };

  useEffect(() => {
    if (!isProcessing && pendingRef.current.length > 0) {
      const next = pendingRef.current.shift()!;
      runPrompt(next);
    }
  }, [isProcessing]);

  const handleSubmitRef = useRef(handleSubmit);
  useEffect(() => { handleSubmitRef.current = handleSubmit; });

  useEffect(() => {
    const listener = (message: any) => {
      if (message.action === 'executeSkillPrompt' && message.skillTitle) {
        handleSubmitRef.current(`esegui la skill "${message.skillTitle}"`);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleCancel = () => {
    pendingRef.current = [];
    if (approvalRequests.length > 0) {
      addSystemMessage(t('approval.cancelled'));
      approvalRequests.forEach(req => rejectRequest(req.requestId));
      setApprovalRequests([]);
    }
    cancelExecution();
    setTabStatus('idle');
  };

  const handleClearHistory = () => {
    pendingRef.current = [];
    cancelExecution();
    clearMessages();
    clearHistory();
    clearTaskHistory();
    TokenTrackingService.getInstance().reset();
    setTabStatus('idle');
  };

  const handleReflectAndLearn = () => {
    chrome.runtime.sendMessage({ action: 'reflectAndLearn', tabId });
    addSystemMessage(t('action.reflect'));
  };

  /**
   * Export the whole session (system messages, LLM output, debug traces with
   * raw LLM responses) as a plain-text log for troubleshooting.
   */
  const handleExportLog = () => {
    const lines: string[] = [
      `DomMotion session log — ${new Date().toISOString()}`,
      `tab: ${tabId ?? '?'} · window: ${windowId ?? '?'}`,
      '='.repeat(70),
      '',
    ];
    for (const msg of messages) {
      const header = msg.type === 'debug'
        ? `[DEBUG · ${msg.debugLabel ?? 'trace'}]`
        : `[${msg.type.toUpperCase()}]`;
      lines.push(header);
      lines.push(msg.content ?? '');
      lines.push('-'.repeat(70));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `dommotion-log-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const navigateToOptions = () => chrome.runtime.openOptionsPage();

  const showEmpty = messages.length === 0 && Object.keys(streamingSegments).length === 0;

  return (
    <div data-theme="dommotion" style={{
      width: '100%', height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--bg)', position: 'relative', overflow: 'hidden',
      fontFamily: 'var(--font-sans)',
    }}>
      <SPHeader
        tabName={tabTitle}
        tabStatus={tabStatus}
        onRefresh={() => { if (tabId) chrome.tabs.reload(tabId); }}
      />

      {hasConfiguredProviders ? (
        <>
          {/* Tabs */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 14px', flex: '0 0 auto',
          }}>
            <div style={{
              display: 'flex', background: 'var(--surface-2)', borderRadius: 999, padding: 3, gap: 3,
            }}>
              <TabButton active={activeTab === 'output'} onClick={() => setActiveTab('output')}>
                {t('sidepanel.output')}
              </TabButton>
              <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')}>
                {t('sidepanel.history')}
              </TabButton>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <IconButton icon="FileDown" size="sm" title={t('action.exportLog')} onClick={handleExportLog} />
              <IconButton icon="BrainCircuit" size="sm" title={t('action.reflect')} onClick={handleReflectAndLearn} />
              <IconButton icon="Trash2" size="sm" title={t('action.clear')} onClick={handleClearHistory} />
            </div>
          </div>

          {/* Content */}
          <div
            ref={outputRef}
            className="ia-scroll"
            style={{ flex: 1, overflowY: 'auto', padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}
          >
            {activeTab === 'output' ? (
              <>
                {showEmpty && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{
                      padding: '10px 12px', borderLeft: '3px solid var(--text-subtle)',
                      background: 'var(--surface)', borderRadius: '0 10px 10px 0',
                      fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.5,
                    }}>
                      {t('sidepanel.disclaimer')}
                    </div>
                  </div>
                )}
                {isProcessing && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                    background: 'var(--primary-soft)', borderRadius: 'var(--radius-md)',
                    color: 'var(--primary)', fontSize: 12, fontWeight: 700, marginTop: 8,
                  }}>
                    <span className="ia-spinner" style={{ width: 14, height: 14 }} />
                    <span>{currentAction ? `${t('sidepanel.running')}: ${currentAction}` : t('sidepanel.thinking')}</span>
                  </div>
                )}
                <MessageDisplay
                  messages={messages}
                  streamingSegments={streamingSegments}
                  isStreaming={isStreaming}
                />
                {showFeedback && !isProcessing && (
                  <FeedbackChips tabId={tabId} windowId={windowId} onDone={() => setShowFeedback(false)} />
                )}
              </>
            ) : (
              <TaskHistory history={taskHistory} onRerun={handleSubmit} />
            )}
          </div>

          {activeTab === 'output' && approvalRequests.length > 0 && (
            <ApprovalRequest
              key={approvalRequests[0].requestId}
              requestId={approvalRequests[0].requestId}
              toolName={approvalRequests[0].toolName}
              toolInput={approvalRequests[0].toolInput}
              reason={approvalRequests[0].reason}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          )}

          <QuickActions executePrompt={executePrompt} isProcessing={isProcessing} />
          <PromptForm
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isProcessing={isProcessing}
            tabStatus={tabStatus}
          />
        </>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <EmptyState
            icon="Unplug"
            title={t('sidepanel.noProvider')}
            description={t('sidepanel.noProviderDesc')}
            cta={<Button icon="Cpu" onClick={navigateToOptions}>{t('sidepanel.configureProvider')}</Button>}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 28, padding: '0 14px', borderRadius: 999, border: 0, cursor: 'pointer',
        fontSize: 12, fontWeight: active ? 700 : 600,
        background: active ? 'var(--surface-elevated)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        boxShadow: active ? 'var(--shadow-card)' : 'none',
        fontFamily: 'inherit', transition: 'background .12s, color .12s',
      }}
    >
      {children}
    </button>
  );
}

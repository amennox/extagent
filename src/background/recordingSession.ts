import { buildProcedure, CapturedAction } from '../procedures/builder';
import { ProcedureStore } from '../procedures/store';
import type { Procedure } from '../procedures/types';
import { resizeImage, toDataUrl } from '../utils/image';
import { logWithTimestamp } from './utils';

/**
 * Recording a procedure by demonstration.
 *
 * - The capture script is injected ON DEMAND in all frames of the recorded
 *   tab (not on every page of the browser), and re-injected after each
 *   navigation while recording.
 * - Every captured action gets a small thumbnail with the target highlighted.
 * - Typed navigations (address bar, bookmarks) become `navigate` steps;
 *   navigations caused by clicks are not duplicated.
 * - The draft is persisted at each step, so a service-worker restart does not
 *   lose the recording.
 */

const KEY_ACTIVE = 'activeRecording';
const THUMB_WIDTH = 360;

export interface ActiveRecording {
  name: string;
  tabId: number;
  windowId: number;
  startUrl?: string;
  actions: CapturedAction[];
  startedAt: number;
}

let lastCaptureAt = 0;
let listenersAttached = false;
/** Serializes read-modify-write of the draft: concurrent steps must never overwrite each other. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function getActive(): Promise<ActiveRecording | null> {
  const res = await chrome.storage.local.get(KEY_ACTIVE);
  return (res?.[KEY_ACTIVE] as ActiveRecording) ?? null;
}

async function setActive(active: ActiveRecording | null): Promise<void> {
  await chrome.storage.local.set({ [KEY_ACTIVE]: active });
}

function notify(payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ action: 'recordingStepAdded', ...payload }).catch?.(() => undefined);
}

async function inject(tabId: number, frameId?: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
      files: ['recording.js'],
    });
  } catch (err) {
    logWithTimestamp(`Recording script injection failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
  }
}

const TYPED_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'start_page']);

async function onCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): Promise<void> {
  return serialized(() => recordNavigation(details));
}

async function recordNavigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): Promise<void> {
  const active = await getActive();
  if (!active || details.tabId !== active.tabId || details.frameId !== 0) return;
  if (!/^https?:/.test(details.url)) return;
  if (!TYPED_TRANSITIONS.has(details.transitionType)) return;
  active.actions.push({ type: 'navigate', url: details.url, pageUrl: details.url, timestamp: Date.now() });
  await setActive(active);
  notify({ count: active.actions.length, description: `Apri ${details.url}` });
}

async function onCompleted(details: chrome.webNavigation.WebNavigationFramedCallbackDetails): Promise<void> {
  const active = await getActive();
  if (!active || details.tabId !== active.tabId) return;
  if (!/^(https?|file):/.test(details.url) && details.url !== 'about:srcdoc') return;
  await inject(details.tabId, details.frameId);
}

function attachListeners(): void {
  if (listenersAttached) return;
  try {
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    listenersAttached = true;
  } catch {
    // webNavigation unavailable
  }
}

function detachListeners(): void {
  try {
    chrome.webNavigation.onCommitted.removeListener(onCommitted);
    chrome.webNavigation.onCompleted.removeListener(onCompleted);
  } catch { /* ignore */ }
  listenersAttached = false;
}

/** Called at service-worker start: keep recording across restarts. */
export async function resumeRecordingIfActive(): Promise<void> {
  if (await getActive()) attachListeners();
}

export async function getRecordingStatus(): Promise<{ active: boolean; name?: string; count?: number }> {
  const active = await getActive();
  return active ? { active: true, name: active.name, count: active.actions.length } : { active: false };
}

export async function startRecording(name?: string): Promise<ActiveRecording> {
  if (await getActive()) throw new Error('A recording is already active');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^(https?|file):/.test(tab.url)) {
    throw new Error('Open a web page in the current tab before recording');
  }
  const stamp = new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const active: ActiveRecording = {
    name: (name ?? '').trim() || `Procedura ${stamp}`,
    tabId: tab.id,
    windowId: tab.windowId,
    startUrl: tab.url,
    actions: [{ type: 'navigate', url: tab.url, pageUrl: tab.url, pageTitle: tab.title, timestamp: Date.now() }],
    startedAt: Date.now(),
  };
  await setActive(active);
  attachListeners();
  await inject(tab.id);
  notify({ count: active.actions.length, description: `Pagina iniziale ${tab.url}` });
  return active;
}

async function thumbnail(windowId: number, rect?: { x: number; y: number; width: number; height: number }, dpr = 1): Promise<string | undefined> {
  const now = Date.now();
  if (now - lastCaptureAt < 550) return undefined; // captureVisibleTab quota: 2/s
  lastCaptureAt = now;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 });
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return undefined;
    const small = await resizeImage({ mediaType: m[1], data: m[2] }, THUMB_WIDTH, 0.6, rect ? { rect, rectScale: dpr } : undefined);
    return toDataUrl(small);
  } catch {
    return undefined;
  }
}

export async function addCapturedStep(
  message: { step: CapturedAction; rect?: { x: number; y: number; width: number; height: number }; dpr?: number },
  sender: chrome.runtime.MessageSender
): Promise<void> {
  // Capture the thumbnail right away (closest to the action), store in order
  const pre = await getActive();
  if (!pre || sender.tab?.id !== pre.tabId) return;
  const thumb = thumbnail(pre.windowId, sender.frameId ? undefined : message.rect, message.dpr ?? 1);
  return serialized(async () => {
    const active = await getActive();
    if (!active || sender.tab?.id !== active.tabId) return;
    const step: CapturedAction = { ...message.step };
    if (sender.frameId && sender.frameId !== 0) step.frameUrl = sender.url ?? step.pageUrl;
    step.thumbnail = await thumb;
    active.actions.push(step);
    await setActive(active);
    const label = step.elementLabel || step.elementText || '';
    notify({ count: active.actions.length, description: `${step.type} ${label}`.trim() });
  });
}

export async function stopRecording(): Promise<Procedure | null> {
  await queue;
  const active = await getActive();
  detachListeners();
  if (!active) return null;
  chrome.tabs.sendMessage(active.tabId, { action: 'stopRecordingCapture' }, () => void chrome.runtime.lastError);
  await setActive(null);
  if (active.actions.filter(a => a.type !== 'navigate').length === 0) return null;
  const proc = buildProcedure(active.actions, { name: active.name, source: 'recording', startUrl: active.startUrl });
  return ProcedureStore.getInstance().save(proc);
}

export async function cancelRecording(): Promise<void> {
  const active = await getActive();
  detachListeners();
  if (active) chrome.tabs.sendMessage(active.tabId, { action: 'stopRecordingCapture' }, () => void chrome.runtime.lastError);
  await setActive(null);
}

import { useState, useRef, useEffect } from 'preact/hooks';
import { apiFetch } from '../api.js';

export interface QuickData {
  history: string[];                        // cross-session
  sessionHistory: Record<string, string[]>; // per-session, keyed by session name
  commands: string[];
  phrases: string[];
}

export const EMPTY_QUICK_DATA: QuickData = { history: [], sessionHistory: {}, commands: [], phrases: [] };

// ── Built-in defaults (not stored in D1, cannot be deleted) ───────────────

const DEFAULT_COMMANDS: Record<string, string[]> = {
  'claude-code': ['/compact', '/clear', '/usage', '/cost', '/status', '/help'],
  'codex':       ['/compact', '/help', '/model', '/approval', '/clear'],
  'opencode':    ['/compact', '/clear', '/model', '/help'],
};
const DEFAULT_PHRASES = ['继续', '修复', '解释下', '重构这个', '写测试', '检查错误', 'LGTM, commit', 'yes'];

const SESSION_HISTORY_MAX = 50;
const GLOBAL_HISTORY_MAX = 50;

// ── Data helpers ──────────────────────────────────────────────────────────

function dedupPrepend(list: string[], text: string, max: number): string[] {
  return [text, ...list.filter((h) => h !== text)].slice(0, max);
}

export function recordHistoryEntry(data: QuickData, text: string, sessionName?: string): QuickData {
  const trimmed = text.trim();
  if (!trimmed) return data;
  const next: QuickData = {
    ...data,
    history: dedupPrepend(data.history, trimmed, GLOBAL_HISTORY_MAX),
  };
  if (sessionName) {
    const prev = data.sessionHistory[sessionName] ?? [];
    next.sessionHistory = {
      ...data.sessionHistory,
      [sessionName]: dedupPrepend(prev, trimmed, SESSION_HISTORY_MAX),
    };
  }
  return next;
}

// ── Hook ──────────────────────────────────────────────────────────────────

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(data: QuickData): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    apiFetch('/api/quick-data', { method: 'PUT', body: JSON.stringify({ data }) }).catch(() => {/* ignore */});
  }, 2000);
}

export interface UseQuickDataResult {
  data: QuickData;
  loaded: boolean;
  recordHistory: (text: string, sessionName?: string) => void;
  addCommand: (cmd: string) => void;
  addPhrase: (phrase: string) => void;
  removeCommand: (cmd: string) => void;
  removePhrase: (phrase: string) => void;
  removeHistory: (text: string) => void;
  removeSessionHistory: (sessionName: string, text: string) => void;
  clearHistory: () => void;
  clearSessionHistory: (sessionName: string) => void;
}

export function useQuickData(): UseQuickDataResult {
  const [data, setData] = useState<QuickData>(EMPTY_QUICK_DATA);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiFetch<{ data: QuickData }>('/api/quick-data').then((res) => {
      // Ensure sessionHistory exists for older data blobs
      const d = res.data;
      if (!d.sessionHistory) d.sessionHistory = {};
      setData(d);
      setLoaded(true);
    }).catch(() => { setLoaded(true); });
  }, []);

  const update = (next: QuickData) => {
    setData(next);
    scheduleSave(next);
  };

  const recordHistory = (text: string, sessionName?: string) => {
    setData((prev) => {
      const next = recordHistoryEntry(prev, text, sessionName);
      scheduleSave(next);
      return next;
    });
  };

  const addCommand = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    setData((prev) => {
      if (prev.commands.includes(trimmed)) return prev;
      const next = { ...prev, commands: [...prev.commands, trimmed] };
      scheduleSave(next);
      return next;
    });
  };

  const addPhrase = (phrase: string) => {
    const trimmed = phrase.trim();
    if (!trimmed) return;
    setData((prev) => {
      if (prev.phrases.includes(trimmed)) return prev;
      const next = { ...prev, phrases: [...prev.phrases, trimmed] };
      scheduleSave(next);
      return next;
    });
  };

  const removeCommand = (cmd: string) => update({ ...data, commands: data.commands.filter((c) => c !== cmd) });
  const removePhrase = (phrase: string) => update({ ...data, phrases: data.phrases.filter((p) => p !== phrase) });
  const removeHistory = (text: string) => update({ ...data, history: data.history.filter((h) => h !== text) });
  const removeSessionHistory = (sessionName: string, text: string) => {
    const prev = data.sessionHistory[sessionName] ?? [];
    update({ ...data, sessionHistory: { ...data.sessionHistory, [sessionName]: prev.filter((h) => h !== text) } });
  };
  const clearHistory = () => update({ ...data, history: [] });
  const clearSessionHistory = (sessionName: string) =>
    update({ ...data, sessionHistory: { ...data.sessionHistory, [sessionName]: [] } });

  return { data, loaded, recordHistory, addCommand, addPhrase, removeCommand, removePhrase, removeHistory, removeSessionHistory, clearHistory, clearSessionHistory };
}

// ── Panel component ───────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (text: string) => void;
  onSend: (text: string) => void;
  agentType: string;
  sessionName: string;
  data: QuickData;
  loaded: boolean;
  onAddCommand: (cmd: string) => void;
  onAddPhrase: (phrase: string) => void;
  onRemoveCommand: (cmd: string) => void;
  onRemovePhrase: (phrase: string) => void;
  onRemoveHistory: (text: string) => void;
  onRemoveSessionHistory: (sessionName: string, text: string) => void;
  onClearHistory: () => void;
  onClearSessionHistory: (sessionName: string) => void;
}

const HISTORY_PAGE_SIZE = 10;
type AddTarget = 'command' | 'phrase' | null;
type HistoryScope = 'session' | 'global';

export function QuickInputPanel({
  open, onClose, onSelect, onSend, agentType, sessionName,
  data, loaded,
  onAddCommand, onAddPhrase, onRemoveCommand, onRemovePhrase,
  onRemoveHistory, onRemoveSessionHistory, onClearHistory, onClearSessionHistory,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [addTarget, setAddTarget] = useState<AddTarget>(null);
  const [addValue, setAddValue] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [historyScope, setHistoryScope] = useState<HistoryScope>('session');

  // Reset page when scope or session changes
  useEffect(() => { setHistoryPage(0); }, [historyScope, sessionName]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  // Focus add input when shown
  useEffect(() => {
    if (addTarget) setTimeout(() => addInputRef.current?.focus(), 50);
  }, [addTarget]);

  if (!open) return null;

  const defaultCmds = DEFAULT_COMMANDS[agentType] ?? DEFAULT_COMMANDS['claude-code'];
  const activeHistory = historyScope === 'session'
    ? (data.sessionHistory[sessionName] ?? [])
    : data.history;
  const totalHistoryPages = Math.ceil(activeHistory.length / HISTORY_PAGE_SIZE);
  const historySlice = activeHistory.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);

  const handleSelect = (text: string) => { onSelect(text); onClose(); };
  const handleSend = (text: string) => { onSend(text); onClose(); };

  const handleClear = () => {
    if (historyScope === 'session') onClearSessionHistory(sessionName);
    else onClearHistory();
  };

  const handleRemoveItem = (text: string) => {
    if (historyScope === 'session') onRemoveSessionHistory(sessionName, text);
    else onRemoveHistory(text);
  };

  const commitAdd = () => {
    const v = addValue.trim();
    if (v) {
      if (addTarget === 'command') onAddCommand(v);
      else if (addTarget === 'phrase') onAddPhrase(v);
    }
    setAddValue('');
    setAddTarget(null);
  };

  const handleAddKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
    if (e.key === 'Escape') { setAddTarget(null); setAddValue(''); }
  };

  return (
    <>
      <div class="qp-backdrop" onClick={onClose} />
      <div class="qp" ref={panelRef}>
        {/* Toolbar */}
        {addTarget ? (
          <div class="qp-add-row">
            <span class="qp-add-label">{addTarget === 'command' ? '命令' : '短语'}</span>
            <input
              ref={addInputRef}
              class="qp-add-input"
              value={addValue}
              onInput={(e) => setAddValue((e.target as HTMLInputElement).value)}
              onKeyDown={handleAddKeyDown}
              placeholder={addTarget === 'command' ? '/compact' : '修复这个问题'}
            />
            <button class="qp-add-confirm" onClick={commitAdd}>＋</button>
            <button class="qp-add-cancel" onClick={() => { setAddTarget(null); setAddValue(''); }}>✕</button>
          </div>
        ) : (
          <div class="qp-toolbar">
            <button class="qp-toolbar-btn" onClick={() => setAddTarget('command')}>＋ 命令</button>
            <button class="qp-toolbar-btn" onClick={() => setAddTarget('phrase')}>＋ 短语</button>
            {activeHistory.length > 0 && (
              <button class="qp-toolbar-btn qp-toolbar-btn-danger" onClick={handleClear}>清空历史</button>
            )}
          </div>
        )}

        <div class="qp-list">
          {!loaded && <div class="qp-empty">加载中…</div>}

          {/* Commands — pill wrap */}
          {loaded && (
            <>
              <div class="qp-section-header">快捷命令</div>
              <div class="qp-pills">
                {defaultCmds.map((cmd) => (
                  <button key={cmd} class="qp-pill qp-pill-default" onClick={() => handleSend(cmd)}>{cmd}</button>
                ))}
                {data.commands.map((cmd) => (
                  <span key={cmd} class="qp-pill qp-pill-custom">
                    <span class="qp-pill-text" onClick={() => handleSend(cmd)}>{cmd}</span>
                    <button class="qp-pill-del" onClick={() => onRemoveCommand(cmd)}>✕</button>
                  </span>
                ))}
              </div>
            </>
          )}

          {/* Phrases — pill wrap */}
          {loaded && (
            <>
              <div class="qp-section-header">快捷短语</div>
              <div class="qp-pills">
                {DEFAULT_PHRASES.map((phrase) => (
                  <button key={phrase} class="qp-pill qp-pill-default" onClick={() => handleSend(phrase)}>{phrase}</button>
                ))}
                {data.phrases.map((phrase) => (
                  <span key={phrase} class="qp-pill qp-pill-custom">
                    <span class="qp-pill-text" onClick={() => handleSend(phrase)}>{phrase}</span>
                    <button class="qp-pill-del" onClick={() => onRemovePhrase(phrase)}>✕</button>
                  </span>
                ))}
              </div>
            </>
          )}

          {/* History — scope toggle + rows */}
          {loaded && (
            <>
              <div class="qp-section-header qp-history-header">
                <span>历史记录</span>
                <div class="qp-scope-toggle">
                  <button
                    class={`qp-scope-btn${historyScope === 'session' ? ' active' : ''}`}
                    onClick={() => setHistoryScope('session')}
                  >本 Session</button>
                  <button
                    class={`qp-scope-btn${historyScope === 'global' ? ' active' : ''}`}
                    onClick={() => setHistoryScope('global')}
                  >全部</button>
                </div>
              </div>
              {historySlice.length > 0 ? historySlice.map((text, i) => (
                <div key={historyPage * HISTORY_PAGE_SIZE + i} class="qp-item qp-item-history" onClick={() => handleSelect(text)}>
                  <span class="qp-item-text">{text}</span>
                  <button class="qp-item-del" onClick={(e) => { e.stopPropagation(); handleRemoveItem(text); }}>✕</button>
                </div>
              )) : (
                <div class="qp-history-empty">
                  {historyScope === 'session' ? '本 Session 暂无历史' : '暂无历史，发送消息后自动保存'}
                </div>
              )}
            </>
          )}
        </div>

        {/* Pagination */}
        {loaded && totalHistoryPages > 1 && (
          <div class="qp-pagination">
            <button class="qp-page-btn" disabled={historyPage === 0} onClick={() => setHistoryPage((p) => p - 1)}>← 较新</button>
            <span class="qp-page-info">{historyPage + 1} / {totalHistoryPages}</span>
            <button class="qp-page-btn" disabled={historyPage >= totalHistoryPages - 1} onClick={() => setHistoryPage((p) => p + 1)}>较旧 →</button>
          </div>
        )}
      </div>
    </>
  );
}

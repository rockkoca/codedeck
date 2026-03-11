import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';

interface Props {
  ws: WsClient | null;
  activeSession: SessionInfo | null;
  latencyMs?: number | null;
  inputRef?: RefObject<HTMLDivElement>;
  /** Called after each shortcut/action button click — use to restore focus to xterm on desktop. */
  onAfterAction?: () => void;
  /** Called before sending input — starts latency timer. */
  onMarkInput?: () => void;
  /** Called when stop is confirmed — immediately removes tab from state. */
  onStopProject?: (project: string) => void;
  /** Called when Rename is selected in the menu. */
  onRenameSession?: () => void;
  /** Display name (rename label) for the active session — shown in placeholder. */
  sessionDisplayName?: string | null;
}

type MenuAction = 'restart' | 'new' | 'stop';
type ModelChoice = 'opus' | 'sonnet' | 'haiku';

const MODEL_STORAGE_KEY = 'codedeck-model';

// Enter moved after ↓ arrow
const SHORTCUTS: Array<{ label: string; title: string; data: string; wide?: boolean }> = [
  { label: 'Esc',  title: 'Escape',     data: '\x1b' },
  { label: '^C',   title: 'Ctrl+C',     data: '\x03' },
  { label: '↑',    title: 'Up arrow',   data: '\x1b[A' },
  { label: '↓',    title: 'Down arrow', data: '\x1b[B' },
  { label: '↵',    title: 'Enter',      data: '\r', wide: true },
  { label: 'Tab',  title: 'Tab',        data: '\t' },
  { label: '↑Tab', title: 'Shift+Tab',  data: '\x1b[Z' },
  { label: '/',    title: 'Slash',      data: '/' },
  { label: '⌫',    title: 'Backspace',  data: '\x7f' },
];

function loadModel(): ModelChoice {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    if (v === 'opus' || v === 'sonnet' || v === 'haiku') return v;
  } catch { /* ignore */ }
  return 'sonnet';
}

export function SessionControls({ ws, activeSession, latencyMs, inputRef, onAfterAction, onMarkInput, onStopProject, onRenameSession, sessionDisplayName }: Props) {
  const [hasText, setHasText] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [model, setModel] = useState<ModelChoice>(loadModel);
  const [confirm, setConfirm] = useState<MenuAction | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Internal ref for contenteditable — also written to the external inputRef
  const divRef = useRef<HTMLDivElement>(null);

  // Keep external inputRef in sync so parent can call .focus()
  useEffect(() => {
    if (inputRef) (inputRef as { current: HTMLDivElement | null }).current = divRef.current;
  });

  const latencyColor = latencyMs == null ? '#94a3b8'
    : latencyMs < 150 ? '#22c55e'
    : latencyMs < 400 ? '#f59e0b'
    : '#ef4444';

  const disabled = !ws?.connected || !activeSession;
  const isClaudeCode = activeSession?.agentType === 'claude-code';

  // Close menus when clicking outside
  useEffect(() => {
    if (!menuOpen && !modelOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirm(null);
      }
      if (modelOpen && modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen, modelOpen]);

  const getText = () => (divRef.current?.textContent ?? '').trim();

  const handleSend = useCallback(() => {
    const text = getText();
    if (!text || !ws || !activeSession) return;
    onMarkInput?.();
    ws.sendSessionCommand('send', { sessionName: activeSession.name, text });
    if (divRef.current) divRef.current.textContent = '';
    setHasText(false);
  }, [ws, activeSession, onMarkInput]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // Plain-text only paste
  const handlePaste = (e: Event) => {
    e.preventDefault();
    const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
    setHasText(!!(divRef.current?.textContent?.trim()));
  };

  const handleShortcut = (data: string) => {
    if (!ws || !activeSession) return;
    onMarkInput?.();
    ws.sendInput(activeSession.name, data);
    onAfterAction?.();
  };

  const startConfirm = (action: MenuAction) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirm(action);
    confirmTimerRef.current = setTimeout(() => setConfirm(null), 3000);
  };

  const handleMenuAction = (action: MenuAction) => {
    if (!ws || !activeSession) return;
    if (confirm === action) {
      if (action === 'restart') {
        ws.sendSessionCommand('restart', { project: activeSession.project });
      } else if (action === 'new') {
        ws.sendSessionCommand('restart', { project: activeSession.project, fresh: true });
      } else {
        onStopProject
          ? onStopProject(activeSession.project)
          : ws.sendSessionCommand('stop', { project: activeSession.project });
      }
      setMenuOpen(false);
      setConfirm(null);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      onAfterAction?.();
    } else {
      startConfirm(action);
    }
  };

  const handleModelSelect = (m: ModelChoice) => {
    if (!ws || !activeSession) return;
    setModel(m);
    try { localStorage.setItem(MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    ws.sendSessionCommand('send', { sessionName: activeSession.name, text: `/model ${m}` });
    setModelOpen(false);
    onAfterAction?.();
  };

  const placeholder = disabled ? 'Not connected' : `Send to ${sessionDisplayName ?? activeSession?.name ?? 'session'}…`;

  return (
    <div class="controls-wrapper">
      {/* Shortcut row */}
      <div class="shortcuts-row">
        <div class="shortcuts">
          {SHORTCUTS.map((s) => (
            <button
              key={s.label}
              class={`shortcut-btn${s.wide ? ' shortcut-btn-wide' : ''}`}
              title={s.title}
              disabled={disabled}
              onClick={() => handleShortcut(s.data)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Model selector — outside overflow-x scroll area so dropdown isn't clipped */}
        {isClaudeCode && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              onClick={() => setModelOpen((o) => !o)}
              disabled={disabled}
              title={`Model: ${model}`}
              style={{ color: '#a78bfa', fontSize: 10 }}
            >
              {model}
            </button>
            {modelOpen && (
              <div class="menu-dropdown">
                {(['opus', 'sonnet', 'haiku'] as const).map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${model === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleModelSelect(m)}
                  >
                    {model === m ? '● ' : '○ '}{m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main input row */}
      <div class="controls">
        {/*
          contenteditable div — iOS does NOT show the password/keychain autofill bar
          for contenteditable elements, unlike <input> or <textarea>.
        */}
        <div
          ref={divRef}
          class={`controls-input${disabled ? ' controls-input-disabled' : ''}`}
          contenteditable={disabled ? 'false' : 'true'}
          role="textbox"
          aria-multiline="true"
          aria-label="Message input"
          data-placeholder={placeholder}
          spellcheck={false}
          onInput={() => setHasText(!!(divRef.current?.textContent?.trim()))}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <button
          class="btn btn-primary"
          onClick={handleSend}
          disabled={disabled || !hasText}
        >
          Send
        </button>

        {/* Menu button */}
        <div class="menu-wrap" ref={menuRef}>
          <button
            class="btn btn-secondary"
            onClick={() => { setMenuOpen((o) => !o); setConfirm(null); }}
            disabled={disabled}
            title="Session actions"
            style={{ padding: '6px 10px' }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div class="menu-dropdown">
              <button
                class={`menu-item ${confirm === 'restart' ? 'menu-item-warn' : ''}`}
                onClick={() => handleMenuAction('restart')}
              >
                {confirm === 'restart' ? '确认重启?' : '↺ Restart'}
              </button>
              <button
                class={`menu-item ${confirm === 'new' ? 'menu-item-warn' : ''}`}
                onClick={() => handleMenuAction('new')}
              >
                {confirm === 'new' ? '确认新建?' : '+ New'}
              </button>
              <button
                class="menu-item"
                onClick={() => { onRenameSession?.(); setMenuOpen(false); }}
              >
                ✎ Rename
              </button>
              <div class="menu-divider" />
              <button
                class={`menu-item ${confirm === 'stop' ? 'menu-item-danger' : ''}`}
                onClick={() => handleMenuAction('stop')}
              >
                {confirm === 'stop' ? '确认关闭?' : '✕ Stop'}
              </button>
            </div>
          )}
        </div>

        <span style={{ marginLeft: 4, fontSize: 12, fontFamily: 'monospace', color: latencyColor, minWidth: 40, whiteSpace: 'nowrap' }}>
          {latencyMs != null ? `${latencyMs}ms` : '—'}
        </span>
      </div>
    </div>
  );
}

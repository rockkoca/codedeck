import { useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  x: number;
  y: number;
  serverName: string;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ServerContextMenu({ x, y, serverName, onRename, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp menu to viewport
  const style: Record<string, string | number> = { position: 'fixed', left: x, top: y };
  if (x + 160 > window.innerWidth) style.left = window.innerWidth - 164;
  if (y + 80 > window.innerHeight) style.top = y - 80;

  return (
    <div ref={ref} class="server-ctx-menu" style={style}>
      <button class="server-ctx-item" onClick={() => { onClose(); onRename(); }}>
        ✎ Rename
      </button>
      <div class="menu-divider" />
      <button class="server-ctx-item server-ctx-item-danger" onClick={() => { onClose(); onDelete(); }}>
        ✕ Delete server
      </button>
    </div>
  );
}

interface DeleteConfirmProps {
  serverName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteServerDialog({ serverName, onConfirm, onCancel }: DeleteConfirmProps) {
  const [typed, setTyped] = useState('');
  const match = typed === serverName;

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="ask-dialog" style={{ maxWidth: 400 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#f87171' }}>删除 server: {serverName}</div>
        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
          这将从服务器删除所有绑定、会话记录，并通知 daemon 停止运行并删除本地凭据。<br />
          <strong style={{ color: '#e2e8f0' }}>tmux 会话不会被关闭</strong>，但 daemon 将不再自动启动。
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
          输入 server 名称确认删除：<code style={{ color: '#f87171', background: '#1e293b', padding: '2px 6px', borderRadius: 4 }}>{serverName}</code>
        </div>
        <input
          class="ask-custom-input"
          style={{ width: '100%' }}
          placeholder={serverName}
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          autoFocus
        />
        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onCancel}>取消</button>
          <button
            class="ask-btn-submit"
            style={{ background: match ? '#ef4444' : '#7f1d1d', opacity: match ? 1 : 0.5, cursor: match ? 'pointer' : 'not-allowed' }}
            disabled={!match}
            onClick={onConfirm}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

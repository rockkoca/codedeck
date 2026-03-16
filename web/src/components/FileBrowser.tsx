/**
 * FileBrowser — universal reusable file/directory browser.
 *
 * Modes:
 *   'dir-only'    — only directories shown, single select (for cwd pickers)
 *   'file-multi'  — files + dirs, multi-select with checkboxes (for chat insert)
 *   'file-single' — files + dirs, single select (for chat path-click)
 *
 * Layouts:
 *   'modal' — rendered as a full-screen overlay dialog
 *   'panel' — rendered inline (no overlay), fits inside a parent container
 */
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';

export type FileBrowserMode = 'dir-only' | 'file-multi' | 'file-single';

export interface FileBrowserProps {
  ws: WsClient;
  mode: FileBrowserMode;
  layout: 'modal' | 'panel';
  initialPath?: string;
  /** When set, pre-select this path on open (file-single / dir-only) */
  highlightPath?: string;
  /** Paths already inserted — shown with a badge to avoid duplicates */
  alreadyInserted?: string[];
  onConfirm: (paths: string[]) => void;
  onClose?: () => void;
}

type FsNode = {
  id: string;        // absolute resolved path
  name: string;
  isDir: boolean;
  hidden?: boolean;
  children?: FsNode[];  // undefined = leaf/file; [] = unloaded dir; [...] = loaded
  isLoading?: boolean;
};

const REQUEST_TIMEOUT_MS = 5_000;

function updateNode(nodes: FsNode[], targetId: string, patch: Partial<FsNode>): FsNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return { ...n, ...patch };
    if (n.children?.length) return { ...n, children: updateNode(n.children, targetId, patch) };
    return n;
  });
}


export function FileBrowser({
  ws,
  mode,
  layout,
  initialPath,
  highlightPath,
  alreadyInserted = [],
  onConfirm,
  onClose,
}: FileBrowserProps) {
  const { t } = useTranslation();
  const includeFiles = mode !== 'dir-only';
  const isMulti = mode === 'file-multi';

  const startPath = initialPath || '~';
  const [data, setData] = useState<FsNode[]>([
    { id: startPath, name: startPath, isDir: true, children: [] },
  ]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(highlightPath ? [highlightPath] : []),
  );
  const [currentLabel, setCurrentLabel] = useState(startPath);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, string>()); // requestId → nodeId
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current.clear();
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  // Listen for fs.ls_response
  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type !== 'fs.ls_response') return;
      if (!mountedRef.current) return;

      const nodeId = pendingRef.current.get(msg.requestId);
      if (!nodeId) return;
      pendingRef.current.delete(msg.requestId);

      const timer = timersRef.current.get(msg.requestId);
      if (timer) { clearTimeout(timer); timersRef.current.delete(msg.requestId); }

      if (msg.status === 'error') {
        setError(msg.error ?? 'Unknown error');
        setData((prev) => updateNode(prev, nodeId, { isLoading: false }));
        return;
      }

      const resolvedParent = msg.resolvedPath ?? nodeId;
      const entries = msg.entries ?? [];
      const children: FsNode[] = entries
        .filter((e) => showHidden || !e.hidden)
        .map((e) => ({
          id: `${resolvedParent}/${e.name}`,
          name: e.name,
          isDir: e.isDir,
          hidden: e.hidden,
          children: e.isDir ? [] : undefined,
        }));

      loadedRef.current.add(nodeId);
      if (resolvedParent !== nodeId) loadedRef.current.add(resolvedParent);

      setData((prev) => updateNode(prev, nodeId, { id: resolvedParent, name: resolvedParent.split('/').pop() || resolvedParent, children, isLoading: false }));
      setCurrentLabel(resolvedParent);
      setError(null);

      // If highlightPath is under this dir, auto-expand
      if (highlightPath && highlightPath.startsWith(resolvedParent + '/')) {
        const nextSegment = highlightPath.slice(resolvedParent.length + 1).split('/')[0];
        const child = children.find((c) => c.name === nextSegment && c.isDir);
        if (child) setTimeout(() => fetchDir(child.id), 0);
      }
    });
  }, [ws, showHidden, highlightPath]);

  const fetchDir = useCallback((nodePath: string) => {
    if (loadedRef.current.has(nodePath)) return;
    const inFlight = [...pendingRef.current.values()].includes(nodePath);
    if (inFlight) return;

    setData((prev) => updateNode(prev, nodePath, { isLoading: true }));
    const requestId = ws.fsListDir(nodePath, includeFiles);
    pendingRef.current.set(requestId, nodePath);

    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      if (pendingRef.current.has(requestId)) {
        pendingRef.current.delete(requestId);
        timersRef.current.delete(requestId);
        setData((prev) => updateNode(prev, nodePath, { isLoading: false }));
        setError(t('file_browser.timeout'));
      }
    }, REQUEST_TIMEOUT_MS);
    timersRef.current.set(requestId, timer);
  }, [ws, includeFiles, t]);

  // Load root on mount
  useEffect(() => { fetchDir(startPath); }, [startPath]);

  // Reload tree when showHidden changes
  useEffect(() => {
    loadedRef.current.clear();
    setData([{ id: startPath, name: startPath, isDir: true, children: [] }]);
    fetchDir(startPath);
  }, [showHidden]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([startPath]));

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) { next.delete(nodeId); } else {
        next.add(nodeId);
        fetchDir(nodeId);
      }
      return next;
    });
  }, [fetchDir]);

  const handleSelect = useCallback((nodeId: string, isDir: boolean) => {
    if (mode === 'dir-only' && !isDir) return;
    if (isMulti) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) { next.delete(nodeId); } else { next.add(nodeId); }
        return next;
      });
    } else {
      setSelectedPaths(new Set([nodeId]));
    }
    if (isDir) {
      const path = nodeId.split('/').pop() || nodeId;
      void path;
      setCurrentLabel(nodeId);
    }
  }, [mode, isMulti]);

  const handleConfirm = () => {
    if (selectedPaths.size === 0) {
      if (mode === 'dir-only') onConfirm([currentLabel]);
      return;
    }
    onConfirm([...selectedPaths]);
  };

  const title = mode === 'dir-only' ? t('file_browser.title_dir') : t('file_browser.title_file');
  const confirmLabel = mode === 'dir-only'
    ? t('file_browser.select')
    : selectedPaths.size > 0
      ? t('file_browser.insert', { count: selectedPaths.size })
      : t('file_browser.select');

  const alreadySet = new Set(alreadyInserted);

  const tree = (
    <div class="fb-tree" style={{ overflowY: 'auto', flex: 1 }}>
      {data.map((root) => (
        <FsTreeNode
          key={root.id}
          node={root}
          expandedPaths={expandedPaths}
          selectedPaths={selectedPaths}
          alreadySet={alreadySet}
          mode={mode}
          showHidden={showHidden}
          onToggleExpand={toggleExpand}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );

  const footer = (
    <div class="fb-footer">
      <label class="fb-hidden-toggle">
        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden((e.target as HTMLInputElement).checked)} />
        {' '}{t('file_browser.show_hidden')}
      </label>
      {isMulti && selectedPaths.size > 0 && (
        <span class="fb-count">{t('file_browser.selected_count', { count: selectedPaths.size })}</span>
      )}
      <div style={{ flex: 1 }} />
      {layout === 'modal' && (
        <button class="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
      )}
      <button
        class="btn btn-primary"
        disabled={mode !== 'dir-only' && selectedPaths.size === 0}
        onClick={handleConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  );

  const breadcrumb = (
    <div class="fb-breadcrumb">
      <span class="fb-breadcrumb-path">{currentLabel}</span>
      {error && <span class="fb-error-inline">{error}</span>}
    </div>
  );

  if (layout === 'panel') {
    return (
      <div class="fb-panel">
        {breadcrumb}
        {tree}
        {footer}
      </div>
    );
  }

  return (
    <div class="fb-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class="fb-modal" onClick={(e) => e.stopPropagation()}>
        <div class="fb-header">
          <span>{title}</span>
          <button class="fb-close" onClick={onClose}>✕</button>
        </div>
        {breadcrumb}
        {tree}
        {footer}
      </div>
    </div>
  );
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function FsTreeNode({
  node,
  expandedPaths,
  selectedPaths,
  alreadySet,
  mode,
  showHidden,
  onToggleExpand,
  onSelect,
  depth = 0,
}: {
  node: FsNode;
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  alreadySet: Set<string>;
  mode: FileBrowserMode;
  showHidden: boolean;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string, isDir: boolean) => void;
  depth?: number;
}) {
  const isExpanded = expandedPaths.has(node.id);
  const isSelected = selectedPaths.has(node.id);
  const isAlready = alreadySet.has(node.id);
  const isMulti = mode === 'file-multi';
  const isDisabled = mode === 'dir-only' && !node.isDir;

  if (!showHidden && node.hidden) return null;

  return (
    <div>
      <div
        class={`fb-node${isSelected ? ' selected' : ''}${isAlready ? ' already' : ''}${isDisabled ? ' disabled' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => {
          if (!isDisabled) onSelect(node.id, node.isDir);
          if (node.isDir) onToggleExpand(node.id);
        }}
      >
        {isMulti && (
          <input
            type="checkbox"
            class="fb-node-check"
            checked={isSelected}
            disabled={isDisabled}
            onClick={(e) => e.stopPropagation()}
            onChange={() => { if (!isDisabled) onSelect(node.id, node.isDir); }}
          />
        )}
        <span class="fb-node-expand">
          {node.isDir ? (isExpanded ? '▾' : '▸') : ' '}
        </span>
        <span class="fb-node-icon">
          {node.isDir
            ? (node.isLoading ? '⟳' : (isExpanded ? '📂' : '📁'))
            : '📄'}
        </span>
        <span class="fb-node-name">{node.name}</span>
        {isAlready && <span class="fb-node-badge">↑</span>}
      </div>
      {node.isDir && isExpanded && node.children && (
        <>
          {node.children.length === 0 && !node.isLoading && (
            <div class="fb-node-empty" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>—</div>
          )}
          {node.children.map((child) => (
            <FsTreeNode
              key={child.id}
              node={child}
              expandedPaths={expandedPaths}
              selectedPaths={selectedPaths}
              alreadySet={alreadySet}
              mode={mode}
              showHidden={showHidden}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </div>
  );
}

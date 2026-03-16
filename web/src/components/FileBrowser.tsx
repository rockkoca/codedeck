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
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJs from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsKotlin from 'highlight.js/lib/languages/kotlin';
import hljsLua from 'highlight.js/lib/languages/lua';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRuby from 'highlight.js/lib/languages/ruby';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsTs from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import { marked } from 'marked';

// Register languages
hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('c', hljsC);
hljs.registerLanguage('cpp', hljsCpp);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('dockerfile', hljsDockerfile);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('javascript', hljsJs);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('kotlin', hljsKotlin);
hljs.registerLanguage('lua', hljsLua);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('ruby', hljsRuby);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('scala', hljsScala);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('typescript', hljsTs);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('yaml', hljsYaml);

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  c: 'c',
  cs: 'javascript', // csharp not registered, fallback
  kt: 'kotlin', kts: 'kotlin',
  sql: 'sql',
  dockerfile: 'dockerfile',
  lua: 'lua',
  scala: 'scala',
  swift: 'swift',
};

function highlightCode(content: string, filename: string): { html: string; isMarkdown: boolean } {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'mdx') {
    return { html: marked(content) as string, isMarkdown: true };
  }
  const lang = EXT_LANG[ext];
  if (lang) {
    try {
      const result = hljs.highlight(content, { language: lang });
      return { html: result.value, isMarkdown: false };
    } catch {
      // fallback
    }
  }
  // Auto-detect for unknown extensions
  try {
    const result = hljs.highlightAuto(content.slice(0, 8192)); // limit for performance
    return { html: result.value, isMarkdown: false };
  } catch {
    return { html: escapeHtml(content), isMarkdown: false };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isBinaryContent(content: string): boolean {
  // Check first 8KB for null bytes (binary indicator)
  const sample = content.slice(0, 8192);
  return sample.includes('\0');
}

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

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ok'; path: string; content: string; html: string; isMarkdown: boolean }
  | { status: 'error'; path: string; error: string };

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
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });

  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, string>()); // requestId → nodeId
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingReadRef = useRef(new Map<string, string>()); // requestId → filePath
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current.clear();
      pendingReadRef.current.clear();
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  // Listen for fs.ls_response and fs.read_response
  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      if (!mountedRef.current) return;

      if (msg.type === 'fs.ls_response') {
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
        return;
      }

      if (msg.type === 'fs.read_response') {
        const filePath = pendingReadRef.current.get(msg.requestId);
        if (!filePath) return;
        pendingReadRef.current.delete(msg.requestId);

        if (msg.status === 'error') {
          const errKey = msg.error === 'file_too_large' ? 'file_browser.preview_too_large'
            : msg.error === 'forbidden_path' ? 'file_browser.preview_error'
            : 'file_browser.preview_error';
          setPreview({ status: 'error', path: filePath, error: t(errKey) });
          return;
        }

        const content = msg.content ?? '';
        if (isBinaryContent(content)) {
          setPreview({ status: 'error', path: filePath, error: t('file_browser.preview_binary') });
          return;
        }

        const filename = filePath.split('/').pop() ?? '';
        const { html, isMarkdown } = highlightCode(content, filename);
        setPreview({ status: 'ok', path: filePath, content, html, isMarkdown });
        return;
      }
    });
  }, [ws, showHidden, highlightPath, t]);

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

  const fetchPreview = useCallback((filePath: string) => {
    setPreview({ status: 'loading', path: filePath });
    const requestId = ws.fsReadFile(filePath);
    pendingReadRef.current.set(requestId, filePath);
  }, [ws]);

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

  const handlePreview = useCallback((filePath: string) => {
    if (preview.status !== 'loading' || (preview as { path: string }).path !== filePath) {
      fetchPreview(filePath);
    }
  }, [fetchPreview, preview]);

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
  const hasPreview = mode !== 'dir-only' && preview.status !== 'idle';

  const previewPath = preview.status !== 'idle' ? (preview as { path: string }).path : null;

  const tree = (
    <div class={`fb-tree${hasPreview ? ' fb-tree-split' : ''}`}>
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
          onPreview={handlePreview}
          previewPath={previewPath}
        />
      ))}
    </div>
  );

  const previewPane = hasPreview ? (
    <div class="fb-preview">
      <div class="fb-preview-header">
        <span class="fb-preview-name">{previewPath!.split('/').pop()}</span>
        <button class="fb-close" onClick={() => setPreview({ status: 'idle' })}>✕</button>
      </div>
      <div class="fb-preview-content">
        {preview.status === 'loading' && (
          <div class="fb-preview-msg">{t('file_browser.preview_loading')}</div>
        )}
        {preview.status === 'error' && (
          <div class="fb-preview-msg fb-preview-error">{preview.error}</div>
        )}
        {preview.status === 'ok' && (
          preview.isMarkdown
            ? <div class="fb-preview-md" dangerouslySetInnerHTML={{ __html: preview.html }} />
            : <pre class="fb-preview-code hljs"><code dangerouslySetInnerHTML={{ __html: preview.html }} /></pre>
        )}
      </div>
    </div>
  ) : null;

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
        <div class={`fb-body${hasPreview ? ' fb-body-split' : ''}`}>
          {tree}
          {previewPane}
        </div>
        {footer}
      </div>
    );
  }

  return (
    <div class="fb-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class={`fb-modal${hasPreview ? ' fb-modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div class="fb-header">
          <span>{title}</span>
          <button class="fb-close" onClick={onClose}>✕</button>
        </div>
        {breadcrumb}
        <div class={`fb-body${hasPreview ? ' fb-body-split' : ''}`}>
          {tree}
          {previewPane}
        </div>
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
  onPreview,
  previewPath,
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
  onPreview: (id: string) => void;
  previewPath: string | null;
  depth?: number;
}) {
  const isExpanded = expandedPaths.has(node.id);
  const isSelected = selectedPaths.has(node.id);
  const isAlready = alreadySet.has(node.id);
  const isMulti = mode === 'file-multi';
  const isDisabled = mode === 'dir-only' && !node.isDir;
  const isPreviewing = previewPath === node.id;

  if (!showHidden && node.hidden) return null;

  return (
    <div>
      <div
        class={`fb-node${isSelected ? ' selected' : ''}${isAlready ? ' already' : ''}${isDisabled ? ' disabled' : ''}${isPreviewing ? ' previewing' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => {
          if (!isMulti && !isDisabled) onSelect(node.id, node.isDir);
          if (node.isDir) onToggleExpand(node.id);
          if (!node.isDir && mode !== 'dir-only') onPreview(node.id);
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
              onPreview={onPreview}
              previewPath={previewPath}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </div>
  );
}

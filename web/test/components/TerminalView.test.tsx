/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen } from '@testing-library/preact';

vi.mock('xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    loadAddon: vi.fn(),
    dispose: vi.fn(),
    options: {},
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

// Mock ResizeObserver which is not available in jsdom
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

import { TerminalView } from '../../src/components/TerminalView.js';
import type { TerminalDiff } from '../../src/types.js';

describe('TerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a container div with terminal-container class', () => {
    const { container } = render(
      <TerminalView sessionName="test-session" />,
    );
    const div = container.querySelector('.terminal-container');
    expect(div).toBeDefined();
    expect(div).not.toBeNull();
  });

  it('calls onDiff with the applyDiff callback on mount', async () => {
    const onDiff = vi.fn();
    render(
      <TerminalView sessionName="test-session" onDiff={onDiff} />,
    );
    expect(onDiff).toHaveBeenCalledOnce();
    expect(typeof onDiff.mock.calls[0][0]).toBe('function');
  });

  it('applyDiff callback calls term.write with joined lines', async () => {
    const { Terminal } = await import('xterm');
    const mockWrite = vi.fn();
    const mockReset = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: mockWrite,
      reset: mockReset,
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      options: {},
    }));

    let capturedApplyDiff: ((diff: TerminalDiff) => void) | undefined;
    const onDiff = vi.fn((fn) => { capturedApplyDiff = fn; });

    render(
      <TerminalView sessionName="my-session" onDiff={onDiff} />,
    );

    expect(capturedApplyDiff).toBeDefined();

    const diff: TerminalDiff = {
      rows: 2,
      lines: [[0, 'line one'], [1, 'line two']],
    };
    capturedApplyDiff!(diff);

    expect(mockReset).toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledWith('line one\r\nline two');
  });

  it('mounts and unmounts without throwing', () => {
    expect(() => {
      const { unmount } = render(
        <TerminalView sessionName="cleanup-session" />,
      );
      unmount();
    }).not.toThrow();
  });

  it('calls Terminal dispose on unmount', async () => {
    const { Terminal } = await import('xterm');
    const mockDispose = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: vi.fn(),
      reset: vi.fn(),
      loadAddon: vi.fn(),
      dispose: mockDispose,
      options: {},
    }));

    const { unmount } = render(
      <TerminalView sessionName="dispose-session" />,
    );
    unmount();
    expect(mockDispose).toHaveBeenCalledOnce();
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent } from '@testing-library/preact';
import { NewSessionDialog } from '../../src/components/NewSessionDialog.js';

const makeWs = () => ({
  sendSessionCommand: vi.fn(),
  connected: true,
});

describe('NewSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders project name input', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('my-project')).toBeDefined();
  });

  it('renders working directory input', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('~/projects/my-project')).toBeDefined();
  });

  it('renders agent type selector', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeDefined();
  });

  it('agent type selector has claude-code, codex, opencode options', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('claude-code');
    expect(options).toContain('codex');
    expect(options).toContain('opencode');
  });

  it('defaults agent type to claude-code', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('claude-code');
  });

  it('cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submit with valid inputs calls ws.sendSessionCommand with correct payload', () => {
    const ws = makeWs();
    const onClose = vi.fn();
    render(<NewSessionDialog ws={ws as any} onClose={onClose} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'my-app' },
    });
    fireEvent.input(screen.getByPlaceholderText('~/projects/my-project'), {
      target: { value: '~/projects/my-app' },
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', {
      project: 'my-app',
      dir: '~/projects/my-app',
      agentType: 'claude-code',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows error when submitting with empty project name', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} />);
    // Clear the project field (it's empty by default, dir has ~/  default)
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.getByText('Project name is required')).toBeDefined();
  });

  it('shows error when not connected', () => {
    const ws = { sendSessionCommand: vi.fn(), connected: false };
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'my-app' },
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.getByText('Not connected')).toBeDefined();
  });

  it('agent type changes when selector is updated', () => {
    const ws = makeWs();
    const onClose = vi.fn();
    render(<NewSessionDialog ws={ws as any} onClose={onClose} />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'codex' } });
    expect(select.value).toBe('codex');

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test-proj' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex',
    }));
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} />);
    const dialog = container.querySelector('[role="dialog"]')!;
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking the backdrop calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} />);
    const backdrop = container.querySelector('[role="dialog"]')!;
    // Simulate clicking the backdrop element itself (currentTarget === target)
    fireEvent.click(backdrop, { target: backdrop });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

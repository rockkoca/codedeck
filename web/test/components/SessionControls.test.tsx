/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent } from '@testing-library/preact';
import { SessionControls } from '../../src/components/SessionControls.js';
import type { SessionInfo } from '../../src/types.js';

const makeWs = () => ({
  sendSessionCommand: vi.fn(),
  connected: true,
});

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  name: 'my-session',
  project: 'my-project',
  role: 'w1',
  agentType: 'worker',
  state: 'idle',
  ...overrides,
});

describe('SessionControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders input and send button', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} />);
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.getByRole('button', { name: /send/i })).toBeDefined();
  });

  it('renders stop button', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeDefined();
  });

  it('send button is disabled when input is empty', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} />);
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('send button is enabled when input has text', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} />);
    const input = screen.getByRole('textbox');
    fireEvent.input(input, { target: { value: 'hello' } });
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking send calls ws.sendSessionCommand with correct args', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} />);
    const input = screen.getByRole('textbox');
    fireEvent.input(input, { target: { value: 'run tests' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      session: 'my-session',
      text: 'run tests',
    });
  });

  it('clears input after send', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(input.value).toBe('');
  });

  it('stop button calls ws.sendSessionCommand with stop action', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { session: 'my-session' });
  });

  it('input changes on typing', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'typed text' } });
    expect(input.value).toBe('typed text');
  });

  it('all controls are disabled when ws is null', () => {
    render(<SessionControls ws={null} activeSession={makeSession()} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    const stopBtn = screen.getByRole('button', { name: /stop/i }) as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(true);
  });

  it('all controls are disabled when activeSession is null', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={null} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('pressing Enter submits the message', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} />);
    const input = screen.getByRole('textbox');
    fireEvent.input(input, { target: { value: 'enter message' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', {
      session: 'my-session',
      text: 'enter message',
    });
  });

  it('pressing Shift+Enter does not submit', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} />);
    const input = screen.getByRole('textbox');
    fireEvent.input(input, { target: { value: 'multiline' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });
});

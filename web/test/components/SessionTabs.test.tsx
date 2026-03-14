/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent } from '@testing-library/preact';
import { SessionTabs } from '../../src/components/SessionTabs.js';
import type { SessionInfo } from '../../src/types.js';

const makeSessions = (overrides: Partial<SessionInfo>[] = []): SessionInfo[] =>
  overrides.map((o, i) => ({
    name: `session_w${i + 1}`,
    project: 'my-project',
    role: `w${i + 1}` as SessionInfo['role'],
    agentType: 'worker',
    state: 'idle',
    ...o,
  }));

describe('SessionTabs', () => {
  it('renders "No active sessions" when sessions array is empty', () => {
    render(
      <SessionTabs sessions={[]} activeSession={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText('No active sessions')).toBeDefined();
  });

  it('renders a button for each session', () => {
    const sessions = makeSessions([{}, {}]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} />,
    );
    const buttons = screen.getAllByRole('tab');
    expect(buttons).toHaveLength(2);
  });

  it('marks the active session button with aria-selected=true', () => {
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs sessions={sessions} activeSession="session_w1" onSelect={vi.fn()} />,
    );
    const buttons = screen.getAllByRole('tab');
    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
    expect(buttons[1].getAttribute('aria-selected')).toBe('false');
  });

  it('calls onSelect with the session name when a tab is clicked', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} />,
    );

    const buttons = screen.getAllByRole('tab');
    fireEvent.click(buttons[1]);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w2');
  });

  it('renders brain tab with brain class and project name', () => {
    const sessions: SessionInfo[] = [{
      name: 'session_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'running',
    }];
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} />,
    );
    const button = screen.getByRole('tab');
    expect(button.className).toContain('brain');
    expect(button.textContent).toContain('my-project');
  });

  it('applies busy class for running session state', () => {
    const sessions = makeSessions([{ name: 'session_w1', state: 'running' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} />,
    );
    const button = screen.getByRole('tab');
    expect(button.className).toContain('busy');
  });

  it('renders tab bar with role=tablist', () => {
    const sessions = makeSessions([{}]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('tablist')).toBeDefined();
  });
});

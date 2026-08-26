import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TodayTaskRow, { type TodayTask } from './TodayTaskRow';

const completeTask = vi.fn<(taskId: string, outcome: string) => Promise<{ error?: string }>>(async () => ({}));
vi.mock('./leads/tasksActions', () => ({
  completeTask: (taskId: string, outcome: string) => completeTask(taskId, outcome),
}));

const TASK: TodayTask = {
  id: 'task-1', lead_id: 'lead-1', practice_name: 'Acme Dental',
  type: 'call', title: 'Follow-up call', due_at: '2026-08-26T09:00:00Z', overdue: true,
};

describe('12. logging a call with an outcome from Today is two taps', () => {
  it('takes exactly two clicks: "Log call" then an outcome', async () => {
    let taps = 0;
    render(<TodayTaskRow task={TASK} onDone={() => {}} />);

    // Tap 1: open the outcome picker.
    fireEvent.click(screen.getByTestId('today-log-call:task-1'));
    taps++;
    expect(screen.getByTestId('today-outcome-picker:task-1')).toBeTruthy();

    // Tap 2: pick an outcome — this click IS the submit.
    fireEvent.click(screen.getByTestId('today-outcome:task-1:reached'));
    taps++;

    expect(taps).toBe(2);
    expect(completeTask).toHaveBeenCalledWith('task-1', 'reached');
    expect(completeTask).toHaveBeenCalledTimes(1);
  });

  it('calls onDone(taskId) once the outcome is recorded', async () => {
    completeTask.mockClear();
    const onDone = vi.fn();
    render(<TodayTaskRow task={TASK} onDone={onDone} />);
    fireEvent.click(screen.getByTestId('today-log-call:task-1'));
    fireEvent.click(screen.getByTestId('today-outcome:task-1:no_answer'));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith('task-1'));
  });

  it('a non-call task shows no "Log call" button at all', () => {
    render(<TodayTaskRow task={{ ...TASK, id: 'task-2', type: 'admin' }} onDone={() => {}} />);
    expect(screen.queryByTestId('today-log-call:task-2')).toBeNull();
  });
});

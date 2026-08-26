'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { TASK_OUTCOMES } from '@/lib/crm/taskOutcomes';

async function guard(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'Unauthorized.' };
  return { ok: true, userId: user.id };
}

// ─── completeTask — the "two taps from Today" call-logging flow ──────
//
// Tap 1 (client-side): opens the compact outcome picker on a task row.
// Tap 2: this action. One request, one write — completes the task AND
// (when it's tied to a lead) logs a matching crm_activities row so the
// timeline shows it, same as logging from the lead detail page would.
// crm_tasks' own trigger (0107) recomputes crm_leads.next_follow_up_at.

export async function completeTask(
  taskId: string,
  outcome: (typeof TASK_OUTCOMES)[number],
): Promise<{ error?: string }> {
  const g = await guard();
  if (!g.ok) return { error: g.error };
  if (!TASK_OUTCOMES.includes(outcome)) return { error: `Invalid outcome: ${outcome}` };

  const supabase = await createClient();

  const { data: task, error: fetchErr } = await supabase
    .from('crm_tasks')
    .select('id, lead_id, type, title')
    .eq('id', taskId)
    .maybeSingle();
  if (fetchErr) return { error: fetchErr.message };
  if (!task) return { error: 'Task not found.' };

  const { error } = await supabase
    .from('crm_tasks')
    .update({ completed_at: new Date().toISOString(), outcome })
    .eq('id', taskId);
  if (error) return { error: error.message };

  if (task.lead_id) {
    await supabase.from('crm_activities').insert({
      lead_id: task.lead_id,
      type: task.type === 'call' ? 'call' : 'note',
      title: task.title,
      body: `Outcome: ${outcome.replace(/_/g, ' ')}`,
      created_by: g.userId,
    });
  }

  revalidatePath('/crm');
  revalidatePath(task.lead_id ? `/crm/leads/${task.lead_id}` : '/crm');
  return {};
}

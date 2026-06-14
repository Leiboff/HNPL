import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ card: null }, { status: 401 });
  }
  // Defense-in-depth: API routes use a 401 instead of the redirect that
  // requireConfirmedUser would do for a server-component page. An
  // unconfirmed user can't read their own payment methods either.
  if (!user.email_confirmed_at) {
    return NextResponse.json({ card: null, error: 'email_not_confirmed' }, { status: 401 });
  }

  const sinceParam = request.nextUrl.searchParams.get('since');
  let windowStart: string;
  try {
    windowStart = sinceParam
      ? new Date(sinceParam).toISOString()
      : new Date(Date.now() - 2 * 60 * 1000).toISOString();
  } catch {
    windowStart = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  }

  const { data } = await supabase
    .from('payment_methods')
    .select('id, card_brand, last_four')
    .eq('patient_id', user.id)
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ card: data ?? null });
}

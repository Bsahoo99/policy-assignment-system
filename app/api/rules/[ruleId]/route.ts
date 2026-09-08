import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock, getQueue } from '../../../../src/runtime';
import { updateRule } from '../../../../src/api/writes';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  try {
    const { ruleId } = await params;
    const body = await req.json();
    const { company_id, effective_at, name, criteria, priority, target_id, effect } = body;
    const db = await getDb();
    await updateRule(
      db,
      company_id,
      ruleId,
      { name, criteria, priority, targetId: target_id, effect },
      new Date(effective_at),
      getClock(),
      await getQueue(),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

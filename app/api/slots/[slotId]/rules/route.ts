import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock, getQueue } from '../../../../../src/runtime';
import { createRule } from '../../../../../src/api/writes';

export async function POST(req: NextRequest, { params }: { params: Promise<{ slotId: string }> }) {
  try {
    const { slotId } = await params;
    const body = await req.json();
    const { company_id, effective_at, name, target_id, criteria, priority, effect, reason } = body;
    const db = await getDb();
    const id = await createRule(
      db,
      company_id,
      { name, slotId, targetId: target_id, criteria, priority, effect, reason },
      new Date(effective_at),
      getClock(),
      await getQueue(),
    );
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

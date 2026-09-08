import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock, getQueue } from '../../../../../src/runtime';
import { createManualOverride } from '../../../../../src/api/writes';

export async function POST(req: NextRequest, { params }: { params: Promise<{ employeeId: string }> }) {
  try {
    const { employeeId } = await params;
    const body = await req.json();
    const { company_id, effective_at, name, slot_id, target_id, criteria, priority, effect, reason } = body;
    const db = await getDb();
    const id = await createManualOverride(
      db,
      company_id,
      employeeId,
      { name, slotId: slot_id, targetId: target_id, criteria, priority, effect, reason },
      new Date(effective_at),
      getClock(),
      await getQueue(),
    );
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '../../../src/runtime';
import { createSlotDependency } from '../../../src/api/writes';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, slot_id, depends_on_slot } = body;
    const db = await getDb();
    await createSlotDependency(db, company_id, slot_id, depends_on_slot);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

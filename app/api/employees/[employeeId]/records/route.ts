import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock, getQueue } from '../../../../../src/runtime';
import { updateEmploymentRecord } from '../../../../../src/api/writes';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ employeeId: string }> }) {
  try {
    const { employeeId } = await params;
    const body = await req.json();
    const { company_id, effective_at, ...fields } = body;
    const db = await getDb();
    await updateEmploymentRecord(db, company_id, employeeId, fields, new Date(effective_at), getClock(), await getQueue());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

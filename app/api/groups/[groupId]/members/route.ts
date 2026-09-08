import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock, getQueue } from '../../../../../src/runtime';
import { addGroupMember, removeGroupMember } from '../../../../../src/api/writes';

export async function POST(req: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  try {
    const { groupId } = await params;
    const body = await req.json();
    const { company_id, employee_id, effective_at } = body;
    const db = await getDb();
    await addGroupMember(db, company_id, groupId, employee_id, new Date(effective_at), getClock(), await getQueue());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  try {
    const { groupId } = await params;
    const body = await req.json();
    const { company_id, employee_id, effective_at } = body;
    const db = await getDb();
    await removeGroupMember(db, company_id, groupId, employee_id, new Date(effective_at), getClock(), await getQueue());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

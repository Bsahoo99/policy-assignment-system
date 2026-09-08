import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock } from '../../../src/runtime';
import { createGroup } from '../../../src/api/writes';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, key, kind, criteria } = body;
    const db = await getDb();
    const id = await createGroup(db, company_id, key, kind, criteria, getClock());
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

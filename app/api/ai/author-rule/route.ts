import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock } from '../../../../src/runtime';
import { authorRule } from '../../../../src/ai';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, description } = body;
    if (!company_id || !description) {
      return NextResponse.json({ error: 'company_id and description are required' }, { status: 400 });
    }
    const db = await getDb();
    const result = await authorRule(db, company_id, description, getClock());
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

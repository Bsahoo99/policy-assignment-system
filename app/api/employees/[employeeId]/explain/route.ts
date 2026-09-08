import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '../../../../../src/runtime';
import { explainEmployee } from '../../../../../src/explain';

export async function GET(req: NextRequest, { params }: { params: Promise<{ employeeId: string }> }) {
  try {
    const { employeeId } = await params;
    const companyId = req.nextUrl.searchParams.get('company_id');
    const validAt = req.nextUrl.searchParams.get('valid_at') ?? req.nextUrl.searchParams.get('at');
    const systemAt = req.nextUrl.searchParams.get('system_at');
    if (!companyId || !validAt) return NextResponse.json({ error: 'company_id and valid_at are required' }, { status: 400 });
    const db = await getDb();
    const items = await explainEmployee(db, companyId, employeeId, new Date(validAt), systemAt ? new Date(systemAt) : undefined);
    return NextResponse.json(items);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

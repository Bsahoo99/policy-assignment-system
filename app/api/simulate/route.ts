import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock } from '../../../src/runtime';
import { simulateEmployee, simulateNewHire } from '../../../src/simulate';
import type { EmployeeState } from '../../../src/predicate';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, employee_id, effective_at, system_at, patch, hypothetical } = body;
    const db = await getDb();
    const systemAt = system_at ? new Date(system_at) : getClock().now();
    const effectiveAt = effective_at ? new Date(effective_at) : systemAt;

    if (hypothetical) {
      const state: EmployeeState = {
        employee_id: employee_id ?? crypto.randomUUID(),
        department: patch?.department ?? null,
        location_state: patch?.location_state ?? null,
        location_country: patch?.location_country ?? 'US',
        employment_type: patch?.employment_type ?? 'w2_employee',
        pay_type: patch?.pay_type ?? 'salary',
        tenure_start_date: patch?.tenure_start_date ?? effectiveAt.toISOString().slice(0, 10),
        direct_report_count: 0,
        group_keys: [],
      };
      const result = await simulateNewHire(db, company_id, effectiveAt, systemAt, state);
      return NextResponse.json(result);
    }

    const result = await simulateEmployee(db, company_id, employee_id, effectiveAt, systemAt, patch);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

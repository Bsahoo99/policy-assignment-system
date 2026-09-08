'use client';

import { useState } from 'react';
import { EMPLOYMENT_TYPES, PAY_TYPES, type EmploymentType, type PayType } from '../../src/types';

interface SlotRow { id: string; key: string; display_name: string }
interface TargetRow { id: string; target_type: string; display_name: string; slotKey: string }
interface PreviewItem { slotId: string; targetId: string }

export function NewHirePreview({
  companyId,
  validAt,
  systemAt,
  slots,
  targets,
}: {
  companyId: string;
  validAt: Date;
  systemAt: Date;
  slots: SlotRow[];
  targets: TargetRow[];
}) {
  const [department, setDepartment] = useState('');
  const [locationState, setLocationState] = useState('');
  const [locationCountry, setLocationCountry] = useState('US');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('w2_employee');
  const [payType, setPayType] = useState<PayType>('salary');
  const [tenureStart, setTenureStart] = useState(validAt.toISOString().slice(0, 10));
  const [result, setResult] = useState<{ added: PreviewItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slotName = new Map(slots.map((s) => [s.id, s.key]));
  const targetName = new Map(targets.map((t) => [t.id, t.display_name]));

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        hypothetical: true,
        effective_at: validAt.toISOString(),
        system_at: systemAt.toISOString(),
        patch: {
          department: department || null,
          location_state: locationState || null,
          location_country: locationCountry,
          employment_type: employmentType,
          pay_type: payType,
          tenure_start_date: tenureStart,
        },
      }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error ?? 'error'); return; }
    setResult(data);
  }

  return (
    <section className="mt-8 border rounded p-4">
      <h2 className="text-lg font-semibold">Preview a new hire</h2>
      <p className="mt-1 text-xs text-gray-500">Simulates what a hypothetical employee would receive without creating any rows.</p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="department" className="border rounded px-2 py-1" />
        <input value={locationState} onChange={(e) => setLocationState(e.target.value)} placeholder="state" className="border rounded px-2 py-1" />
        <input value={locationCountry} onChange={(e) => setLocationCountry(e.target.value)} placeholder="country" className="border rounded px-2 py-1" />
        <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType)} className="border rounded px-2 py-1">
          {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={payType} onChange={(e) => setPayType(e.target.value as PayType)} className="border rounded px-2 py-1">
          {PAY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="date" value={tenureStart} onChange={(e) => setTenureStart(e.target.value)} className="border rounded px-2 py-1" />
      </div>
      <button onClick={run} disabled={loading} className="mt-3 bg-blue-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50">
        {loading ? 'Simulating…' : 'Preview'}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {result && (
        <ul className="mt-3 space-y-1 text-sm">
          {result.added.length === 0 && <li className="text-gray-500">No assignments would be granted.</li>}
          {result.added.map((item, i) => (
            <li key={i} className="border rounded p-2">
              <strong>{slotName.get(item.slotId) ?? item.slotId}</strong> → {targetName.get(item.targetId) ?? item.targetId}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

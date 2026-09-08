'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Group { id: string; key: string; kind: string }
interface Employee { id: string; first_name: string; last_name: string }

export function GroupForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<'static' | 'dynamic'>('static');
  const [criteriaText, setCriteriaText] = useState('{\n  "op": "eq",\n  "field": "department",\n  "value": "Engineering"\n}');
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setMessage(null);
    let criteria: unknown | undefined;
    if (kind === 'dynamic') {
      try {
        criteria = JSON.parse(criteriaText);
      } catch {
        setMessage('criteria is not valid JSON');
        return;
      }
    }
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, key, kind, criteria }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setMessage(`group ${data.id} created`);
    router.refresh();
  }

  return (
    <section className="mt-8 border rounded p-4">
      <h2 className="text-lg font-semibold">Create group</h2>
      <div className="mt-2 flex flex-wrap gap-2 text-sm items-center">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="key" className="border rounded px-2 py-1" />
        <select value={kind} onChange={(e) => setKind(e.target.value as 'static' | 'dynamic')} className="border rounded px-2 py-1">
          <option value="static">static</option>
          <option value="dynamic">dynamic</option>
        </select>
        <button onClick={submit} disabled={!key} className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50">Create</button>
      </div>
      {kind === 'dynamic' && (
        <textarea value={criteriaText} onChange={(e) => setCriteriaText(e.target.value)} rows={4} className="mt-2 w-full border rounded px-2 py-1 font-mono text-xs" />
      )}
      {message && <p className="mt-2 text-sm">{message}</p>}
    </section>
  );
}

export function MemberForm({
  companyId,
  groups,
  employees,
}: {
  companyId: string;
  groups: Group[];
  employees: Employee[];
}) {
  const router = useRouter();
  const staticGroups = groups.filter((g) => g.kind === 'static');
  const [groupId, setGroupId] = useState(staticGroups[0]?.id ?? '');
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setMessage(null);
    const res = await fetch(`/api/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, employee_id: employeeId, effective_at: effectiveAt }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setMessage('member added');
    router.refresh();
  }

  return (
    <section className="mt-8 border rounded p-4">
      <h2 className="text-lg font-semibold">Add member</h2>
      <div className="mt-2 flex flex-wrap gap-2 text-sm items-center">
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="border rounded px-2 py-1">
          {staticGroups.map((g) => <option key={g.id} value={g.id}>{g.key}</option>)}
        </select>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="border rounded px-2 py-1">
          {employees.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
        </select>
        <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} className="border rounded px-2 py-1" />
        <button onClick={submit} disabled={!groupId || !employeeId} className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50">Add</button>
      </div>
      {message && <p className="mt-2 text-sm">{message}</p>}
    </section>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface SimItem {
  slotId: string;
  targetId: string;
  reason: string;
}

interface SimResult {
  added: SimItem[];
  removed: SimItem[];
  unchanged: SimItem[];
}

export function SimulateForm({ companyId, employeeId, validAt, systemAt, targetNames }: { companyId: string; employeeId: string; validAt: Date; systemAt: Date; targetNames: Record<string, string> }) {
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    setError(null);
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, employee_id: employeeId, effective_at: validAt.toISOString(), system_at: systemAt.toISOString() }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error ?? 'error'); setResult(null); return; }
    setResult(data);
  }

  return (
    <section className="mt-6 border rounded p-4">
      <h2 className="text-lg font-semibold">Simulate (no writes)</h2>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={run} disabled={loading} className="bg-blue-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50">
          {loading ? 'Running…' : 'Simulate'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {result && (
        <div className="mt-3 text-sm space-y-1">
          <p><strong className="text-green-700">added:</strong> {result.added.map((i) => `${targetNames[i.targetId] ?? i.targetId} (${i.reason})`).join(', ') || '—'}</p>
          <p><strong className="text-red-700">removed:</strong> {result.removed.map((i) => `${targetNames[i.targetId] ?? i.targetId} (${i.reason})`).join(', ') || '—'}</p>
          <p><strong className="text-gray-700">unchanged:</strong> {result.unchanged.map((i) => targetNames[i.targetId] ?? i.targetId).join(', ') || '—'}</p>
        </div>
      )}
    </section>
  );
}

export function OverrideForm({
  companyId,
  employeeId,
  slots,
  targets,
}: {
  companyId: string;
  employeeId: string;
  slots: { id: string; key: string; target_type: string; display_name: string }[];
  targets: { id: string; target_type: string; display_name: string }[];
}) {
  const router = useRouter();
  const [slotId, setSlotId] = useState(slots[0]?.id ?? '');
  const [targetId, setTargetId] = useState('');
  const [effect, setEffect] = useState<'grant' | 'deny'>('grant');
  const [reason, setReason] = useState('');
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState<string | null>(null);

  const slot = slots.find((s) => s.id === slotId);
  const slotTargets = targets.filter((t) => t.target_type === slot?.target_type);

  async function submit() {
    setMessage(null);
    const res = await fetch(`/api/employees/${employeeId}/overrides`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        effective_at: effectiveAt,
        name: `Manual ${effect}: ${reason || 'override'}`,
        slot_id: slotId,
        target_id: targetId,
        effect,
        priority: 100,
        reason,
      }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setMessage(`override ${data.id} created`);
    router.refresh();
  }

  return (
    <section className="mt-6 border rounded p-4">
      <h2 className="text-lg font-semibold">Manual override</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <select value={slotId} onChange={(e) => { setSlotId(e.target.value); setTargetId(''); }} className="border rounded px-2 py-1">
          {slots.map((s) => <option key={s.id} value={s.id}>{s.key}</option>)}
        </select>
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="border rounded px-2 py-1">
          <option value="">target…</option>
          {slotTargets.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
        </select>
        <select value={effect} onChange={(e) => setEffect(e.target.value as 'grant' | 'deny')} className="border rounded px-2 py-1">
          <option value="grant">grant</option>
          <option value="deny">deny</option>
        </select>
        <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} className="border rounded px-2 py-1" />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason" className="border rounded px-2 py-1" />
        <button onClick={submit} disabled={!targetId} className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50">Apply</button>
      </div>
      {message && <p className="mt-2 text-sm">{message}</p>}
    </section>
  );
}

export function RecordForm({
  companyId,
  employeeId,
  record,
  targetNames,
  validAt,
  systemAt,
}: {
  companyId: string;
  employeeId: string;
  record: {
    department: string | null;
    location_state: string | null;
    location_country: string;
    employment_type: string;
    pay_type: string;
  };
  targetNames: Record<string, string>;
  validAt: Date;
  systemAt: Date;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [department, setDepartment] = useState(record.department ?? '');
  const [state, setState] = useState(record.location_state ?? '');
  const [country, setCountry] = useState(record.location_country);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<SimResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const patch = {
    department: department || null,
    location_state: state || null,
    location_country: country,
  };

  async function previewImpact() {
    setPreviewing(true);
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, employee_id: employeeId, effective_at: validAt.toISOString(), system_at: systemAt.toISOString(), patch }),
    });
    setPreviewing(false);
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'preview failed'); setPreview(null); return; }
    setMessage(null);
    setPreview(data);
  }

  async function submit() {
    setMessage(null);
    const res = await fetch(`/api/employees/${employeeId}/records`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        effective_at: validAt.toISOString(),
        ...patch,
      }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setMessage('record updated');
    setPreview(null);
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 text-sm text-blue-600 hover:underline">
        Edit record…
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="department" className="border rounded px-2 py-1" />
        <input value={state} onChange={(e) => setState(e.target.value)} placeholder="state" className="border rounded px-2 py-1 w-20" />
        <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="country" className="border rounded px-2 py-1 w-20" />
        <button onClick={previewImpact} disabled={previewing} className="bg-gray-100 rounded px-3 py-1 disabled:opacity-50">
          {previewing ? 'Previewing…' : 'Preview impact'}
        </button>
        <button onClick={submit} className="bg-blue-600 text-white rounded px-3 py-1">Save</button>
        <button onClick={() => setOpen(false)} className="text-gray-500">Cancel</button>
      </div>
      {preview && (
        <div className="rounded bg-gray-50 p-2 text-xs space-y-1">
          <p className="text-green-700"><strong>would add:</strong> {preview.added.map((i) => targetNames[i.targetId] ?? i.targetId).join(', ') || '—'}</p>
          <p className="text-red-700"><strong>would remove:</strong> {preview.removed.map((i) => targetNames[i.targetId] ?? i.targetId).join(', ') || '—'}</p>
          <p className="text-gray-700"><strong>would keep:</strong> {preview.unchanged.map((i) => targetNames[i.targetId] ?? i.targetId).join(', ') || '—'}</p>
        </div>
      )}
      {message && <span>{message}</span>}
    </div>
  );
}

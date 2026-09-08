'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Slot { id: string; key: string }
interface Target { id: string; slotKey: string; display_name: string }
interface RuleRow { rule_id: string; slot_key: string; priority: number }
interface ImpactChange { slotId: string; slotKey: string; targetId: string; reason: string }
interface PreviewResult {
  impacted: { employeeId: string; firstName: string; lastName: string; added: ImpactChange[]; removed: ImpactChange[] }[];
  totalCandidates: number;
  truncated: boolean;
}

interface Condition {
  kind: 'eq' | 'in' | 'gte_tenure' | 'in_group' | 'is_manager';
  field?: string;
  value?: string;
  values?: string;
  years?: string;
  group?: string;
}

const SCALAR_FIELDS = ['department', 'location_state', 'location_country', 'employment_type', 'pay_type'] as const;

function buildPredicate(conditions: Condition[], combine: 'and' | 'or'): unknown {
  const nodes = conditions
    .filter((c) => {
      if (c.kind === 'eq') return c.field && c.value !== undefined;
      if (c.kind === 'in') return c.field && c.values?.trim();
      if (c.kind === 'gte_tenure') return c.years !== undefined && c.years !== '';
      if (c.kind === 'in_group') return c.group?.trim();
      return true;
    })
    .map((c) => {
      if (c.kind === 'eq') return { op: 'eq', field: c.field, value: c.value };
      if (c.kind === 'in') return { op: 'in', field: c.field, values: c.values!.split(',').map((v) => v.trim()).filter(Boolean) };
      if (c.kind === 'gte_tenure') return { op: 'gte_tenure', years: Number(c.years) };
      if (c.kind === 'in_group') return { op: 'in_group', group: c.group };
      return { op: 'is_manager' };
    });
  if (nodes.length === 0) return { op: 'always' };
  if (nodes.length === 1) return nodes[0];
  return { op: combine, children: nodes };
}

function StructuredRuleBuilder({
  onCriteria,
  onPreview,
  preview,
  previewing,
  colliding,
}: {
  onCriteria: (json: string) => void;
  onPreview: (criteria: unknown) => Promise<void>;
  preview: PreviewResult | null;
  previewing: boolean;
  colliding: number;
}) {
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [combine, setCombine] = useState<'and' | 'or'>('and');

  function update(index: number, patch: Partial<Condition>) {
    setConditions((cs) => cs.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function add(kind: Condition['kind']) {
    setConditions((cs) => [...cs, { kind }]);
  }

  function remove(index: number) {
    setConditions((cs) => cs.filter((_, i) => i !== index));
  }

  const criteria = buildPredicate(conditions, combine);
  const criteriaJson = JSON.stringify(criteria, null, 2);

  function apply() {
    onCriteria(criteriaJson);
  }

  function previewNow() {
    apply();
    onPreview(criteria);
  }

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Structured rule builder</h3>
        <div className="flex gap-1">
          <button onClick={() => add('eq')} className="rounded border px-2 py-0.5">equals</button>
          <button onClick={() => add('in')} className="rounded border px-2 py-0.5">in</button>
          <button onClick={() => add('gte_tenure')} className="rounded border px-2 py-0.5">tenure</button>
          <button onClick={() => add('in_group')} className="rounded border px-2 py-0.5">group</button>
          <button onClick={() => add('is_manager')} className="rounded border px-2 py-0.5">manager</button>
        </div>
      </div>

      {conditions.length === 0 && <p className="mt-2 text-gray-500">Add a condition to build a predicate.</p>}

      <div className="mt-2 space-y-2">
        {conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-16 text-xs font-mono text-gray-600">{c.kind}</span>
            {(c.kind === 'eq' || c.kind === 'in') && (
              <select value={c.field ?? ''} onChange={(e) => update(i, { field: e.target.value })} className="rounded border px-2 py-0.5">
                <option value="">field…</option>
                {SCALAR_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
            {c.kind === 'eq' && <input value={c.value ?? ''} onChange={(e) => update(i, { value: e.target.value })} placeholder="value" className="rounded border px-2 py-0.5" />}
            {c.kind === 'in' && <input value={c.values ?? ''} onChange={(e) => update(i, { values: e.target.value })} placeholder="a, b, c" className="rounded border px-2 py-0.5" />}
            {c.kind === 'gte_tenure' && <input type="number" value={c.years ?? ''} onChange={(e) => update(i, { years: e.target.value })} placeholder="years" className="w-20 rounded border px-2 py-0.5" />}
            {c.kind === 'in_group' && <input value={c.group ?? ''} onChange={(e) => update(i, { group: e.target.value })} placeholder="group key" className="rounded border px-2 py-0.5" />}
            <button onClick={() => remove(i)} className="text-xs text-red-600">remove</button>
          </div>
        ))}
      </div>

      {conditions.length > 1 && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-600">combine:</span>
          <select value={combine} onChange={(e) => setCombine(e.target.value as 'and' | 'or')} className="rounded border px-2 py-0.5">
            <option value="and">and</option>
            <option value="or">or</option>
          </select>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button onClick={previewNow} disabled={previewing} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
          {previewing ? 'Matching…' : 'Preview match count'}
        </button>
        {preview && <span className="text-gray-700">{preview.impacted.length} employee(s) would change</span>}
        {colliding > 0 && <span className="text-amber-600">⚠ equal-priority rule exists in this slot</span>}
      </div>
      {preview && preview.impacted.length > 0 && (
        <p className="mt-1 text-xs text-gray-500">{preview.impacted.map((e) => `${e.firstName} ${e.lastName}`).join(', ')}{preview.truncated ? ' …' : ''}</p>
      )}
    </div>
  );
}

export function RuleForm({
  companyId,
  slots,
  targets,
  rules,
  initialCriteria,
  systemAt,
}: {
  companyId: string;
  slots: Slot[];
  targets: Target[];
  rules: RuleRow[];
  initialCriteria?: string;
  systemAt: Date;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slotId, setSlotId] = useState(slots[0]?.id ?? '');
  const [targetId, setTargetId] = useState('');
  const [priority, setPriority] = useState(0);
  const [effect, setEffect] = useState<'grant' | 'deny'>('grant');
  const [criteriaText, setCriteriaText] = useState(initialCriteria ?? '{\n  "op": "always"\n}');
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);

  const slotKey = slots.find((s) => s.id === slotId)?.key;
  const slotTargets = targets.filter((t) => t.slotKey === slotKey);
  const colliding = rules.filter((r) => r.slot_key === slotKey && r.priority === priority);

  async function previewImpact(criteriaOverride?: unknown) {
    setMessage(null);
    setPreview(null);
    let criteria: unknown = criteriaOverride;
    if (criteria === undefined) {
      try {
        criteria = JSON.parse(criteriaText);
      } catch {
        setMessage('criteria is not valid JSON');
        return;
      }
    }
    setPreviewing(true);
    const res = await fetch('/api/rules/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        criteria,
        slot_id: slotId,
        target_id: targetId || undefined,
        effect,
        priority,
        name,
        effective_at: effectiveAt,
        system_at: systemAt.toISOString(),
      }),
    });
    const data = await res.json();
    setPreviewing(false);
    if (!res.ok) { setMessage(data.error ?? 'preview failed'); return; }
    setPreview(data);
  }

  async function submit() {
    setMessage(null);
    let criteria: unknown;
    try {
      criteria = JSON.parse(criteriaText);
    } catch {
      setMessage('criteria is not valid JSON');
      return;
    }
    const res = await fetch(`/api/slots/${slotId}/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, effective_at: effectiveAt, name, target_id: targetId, criteria, priority, effect }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setMessage(`rule ${data.id} created`);
    router.refresh();
  }

  return (
    <section className="mt-8 border rounded p-4">
      <h2 className="text-lg font-semibold">Create rule</h2>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="border rounded px-2 py-1" />
        <select value={slotId} onChange={(e) => { setSlotId(e.target.value); setTargetId(''); }} className="border rounded px-2 py-1">
          {slots.map((s) => <option key={s.id} value={s.id}>{s.key}</option>)}
        </select>
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="border rounded px-2 py-1">
          <option value="">target…</option>
          {slotTargets.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
        </select>
        <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} placeholder="priority" className="border rounded px-2 py-1" />
        <select value={effect} onChange={(e) => setEffect(e.target.value as 'grant' | 'deny')} className="border rounded px-2 py-1">
          <option value="grant">grant</option>
          <option value="deny">deny</option>
        </select>
        <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} className="border rounded px-2 py-1" />
      </div>
      <textarea
        value={criteriaText}
        onChange={(e) => setCriteriaText(e.target.value)}
        rows={4}
        className="mt-2 w-full border rounded px-2 py-1 font-mono text-xs"
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => setBuilderOpen((v) => !v)} className="border rounded px-3 py-1 text-sm">
          {builderOpen ? 'Hide builder' : 'Structured builder'}
        </button>
        <button onClick={() => previewImpact()} disabled={previewing || !criteriaText.trim()} className="border rounded px-3 py-1 text-sm disabled:opacity-50">
          {previewing ? 'Previewing…' : 'Preview impact'}
        </button>
        <button onClick={submit} disabled={!name || !targetId} className="bg-blue-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50">
          Create
        </button>
      </div>
      {colliding.length > 0 && (
        <p className="mt-2 text-sm text-amber-600">Another rule in this slot already has priority {priority}.</p>
      )}
      {builderOpen && (
        <StructuredRuleBuilder
          onCriteria={(json) => setCriteriaText(json)}
          onPreview={(criteria) => previewImpact(criteria)}
          preview={preview}
          previewing={previewing}
          colliding={colliding.length}
        />
      )}
      {preview && !builderOpen && (
        <div className="mt-2 text-sm text-gray-700">
          {preview.impacted.length === 0
            ? `No assignments would change (${preview.totalCandidates} candidate(s) unaffected).`
            : `${preview.impacted.length} employee(s) would gain or lose an assignment${preview.truncated ? ' (preview capped)' : ''}:`}
          <ul className="mt-1 space-y-1 text-xs">
            {preview.impacted.map((e) => (
              <li key={e.employeeId} className="border rounded p-2">
                <strong>{e.firstName} {e.lastName}</strong>
                {e.added.map((c, i) => (
                  <div key={`a${i}`} className="text-green-700">+ {c.slotKey} → {targets.find((t) => t.id === c.targetId)?.display_name ?? c.targetId} <span className="text-gray-400">({c.reason})</span></div>
                ))}
                {e.removed.map((c, i) => (
                  <div key={`r${i}`} className="text-red-700">− {c.slotKey} → {targets.find((t) => t.id === c.targetId)?.display_name ?? c.targetId} <span className="text-gray-400">({c.reason})</span></div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {message && <p className="mt-2 text-sm">{message}</p>}
    </section>
  );
}

export function AiAuthor({ companyId, slots, targets }: { companyId: string; slots: Slot[]; targets: Target[] }) {
  const router = useRouter();
  const [description, setDescription] = useState('');
  const [proposed, setProposed] = useState<string | null>(null);
  const [slotId, setSlotId] = useState(slots[0]?.id ?? '');
  const [targetId, setTargetId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function propose() {
    setMessage(null);
    const res = await fetch('/api/ai/author-rule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, description }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setProposed(JSON.stringify(data.criteria, null, 2));
  }

  async function create() {
    if (!proposed || !targetId) return;
    const res = await fetch(`/api/slots/${slotId}/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        effective_at: new Date().toISOString().slice(0, 10),
        name: description.slice(0, 80),
        target_id: targetId,
        criteria: JSON.parse(proposed),
        priority: 0,
        effect: 'grant',
      }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage(data.error ?? 'error'); return; }
    setMessage(`rule ${data.id} created`);
    setProposed(null);
    router.refresh();
  }

  return (
    <section className="mt-8 border rounded p-4">
      <h2 className="text-lg font-semibold">AI rule author</h2>
      <div className="mt-2 flex gap-2 text-sm">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. employees in Engineering with 2+ years tenure" className="flex-1 border rounded px-2 py-1" />
        <button onClick={propose} disabled={!description} className="bg-purple-600 text-white rounded px-3 py-1 disabled:opacity-50">Propose</button>
      </div>
      {proposed && (
        <div className="mt-3 space-y-2 text-sm">
          <textarea value={proposed} onChange={(e) => setProposed(e.target.value)} rows={5} className="w-full border rounded px-2 py-1 font-mono text-xs" />
          <div className="flex gap-2">
            <select value={slotId} onChange={(e) => { setSlotId(e.target.value); setTargetId(''); }} className="border rounded px-2 py-1">
              {slots.map((s) => <option key={s.id} value={s.id}>{s.key}</option>)}
            </select>
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="border rounded px-2 py-1">
              <option value="">target…</option>
              {targets.filter((t) => t.slotKey === slots.find((s) => s.id === slotId)?.key).map((t) => (
                <option key={t.id} value={t.id}>{t.display_name}</option>
              ))}
            </select>
            <button onClick={create} disabled={!targetId} className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50">Create rule</button>
          </div>
        </div>
      )}
      {message && <p className="mt-2 text-sm">{message}</p>}
    </section>
  );
}

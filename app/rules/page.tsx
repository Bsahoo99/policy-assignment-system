export const dynamic = 'force-dynamic';
import { getDb, getClock } from '../../src/runtime';
import { computeHealthReport } from '../../src/health';
import { RuleForm, AiAuthor } from './client';
import Link from 'next/link';

interface SlotRow { id: string; key: string; display_name: string; cardinality: string }
interface TargetRow { id: string; slotKey: string; target_type: string; display_name: string }
interface RuleRow {
  rule_id: string;
  name: string;
  source: string;
  effect: string;
  priority: number;
  criteria: unknown;
  slot_key: string;
  target_name: string;
  valid_lower: string;
}

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const sp = await searchParams;
  const db = await getDb();
  const now = getClock().now();
  const systemAt = typeof sp.system_at === 'string' ? new Date(sp.system_at) : now;
  const validAt = typeof sp.valid_at === 'string' ? new Date(sp.valid_at) : now;
  const { rows: companies } = await db.query<{ id: string; name: string }>('SELECT id, name FROM companies ORDER BY name');
  const company = companies[0];
  if (!company) return <main className="p-8">No company.</main>;

  const [{ rows: slots }, { rows: targets }, { rows: rules }] = await Promise.all([
    db.query<SlotRow>('SELECT id, key, display_name, cardinality FROM assignment_slots WHERE company_id = $1 ORDER BY key', [company.id]),
    db.query<TargetRow>(
      `SELECT at.id, s.key AS "slotKey", at.target_type, at.display_name
       FROM assignment_targets at
       JOIN assignment_slots s ON s.company_id = at.company_id AND s.target_type = at.target_type
       WHERE at.company_id = $1
       ORDER BY at.display_name`,
      [company.id],
    ),
    db.query<RuleRow>(
      `SELECT DISTINCT ON (ar.rule_id) ar.rule_id, ar.name, ar.source, ar.effect, ar.priority, ar.criteria,
              s.key AS slot_key, at.display_name AS target_name, lower(ar.valid)::text AS valid_lower
       FROM assignment_rules ar
       JOIN assignment_slots s ON s.id = ar.slot_id
       JOIN assignment_targets at ON at.id = ar.target_id
       WHERE ar.company_id = $1 AND ar.system @> $2::timestamptz AND ar.valid @> $3::timestamptz
       ORDER BY ar.rule_id, lower(ar.valid) DESC`,
      [company.id, systemAt.toISOString(), validAt.toISOString()],
    ),
  ]);

  const bySlot = new Map<string, RuleRow[]>();
  for (const r of rules) {
    bySlot.set(r.slot_key, [...(bySlot.get(r.slot_key) ?? []), r]);
  }

  // Aggregate the verdicts resolution already produces across the population.
  // This is the same resolveEmployee path reconciliation uses — not a second
  // evaluator that could disagree with it.
  const health = await computeHealthReport(db, company.id, validAt);
  const healthByRule = new Map(health.rules.map((h) => [h.ruleId, h]));
  const hasFindings =
    health.rules.some((r) => r.verdict !== 'healthy') ||
    health.collisions.length > 0 ||
    health.unfilled.length > 0;

  return (
    <main className="p-8 max-w-4xl">
      <Link href="/" className="text-blue-600 hover:underline">&larr; Employees</Link>
      <h1 className="mt-4 text-2xl font-bold">Rules</h1>

      <section className="mt-6 border rounded p-4">
        <h2 className="text-lg font-semibold">Rule health</h2>
        <p className="mt-1 text-xs text-gray-500">
          Aggregated from a full resolution pass over the current population at{' '}
          {validAt.toISOString().slice(0, 10)} (UTC).
        </p>
        {!hasFindings && <p className="mt-2 text-sm text-green-700">All rules are winning for someone; no collisions or unfilled required slots.</p>}
        {health.collisions.length > 0 && (
          <div className="mt-2">
            <h3 className="text-sm font-semibold text-red-700">Priority collisions</h3>
            <ul className="mt-1 space-y-1 text-xs text-gray-700">
              {health.collisions.map((c, i) => <li key={i}>{c.detail}</li>)}
            </ul>
          </div>
        )}
        {health.unfilled.length > 0 && (
          <div className="mt-2">
            <h3 className="text-sm font-semibold text-amber-700">Unfilled required slots</h3>
            <ul className="mt-1 space-y-1 text-xs text-gray-700">
              {health.unfilled.map((u, i) => <li key={i}>{u.detail}</li>)}
            </ul>
          </div>
        )}
        {health.rules.filter((r) => r.verdict !== 'healthy').length > 0 && (
          <div className="mt-2">
            <h3 className="text-sm font-semibold text-gray-700">Rules with no effect</h3>
            <ul className="mt-1 space-y-1 text-xs text-gray-700">
              {health.rules.filter((r) => r.verdict !== 'healthy').map((r) => (
                <li key={r.ruleId}>
                  <strong>{r.name}</strong> <span className="text-gray-400">({r.slotKey}, {r.verdict})</span> — {r.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {slots.map((s) => (
        <section key={s.id} className="mt-6 border rounded p-4">
          <h2 className="text-lg font-semibold">{s.key} <span className="text-sm font-normal text-gray-500">({s.cardinality})</span></h2>
          <ul className="mt-2 space-y-2">
            {(bySlot.get(s.key) ?? []).map((r) => {
              const h = healthByRule.get(r.rule_id);
              return (
                <li key={r.rule_id} className="text-sm border rounded p-2">
                  <div className="flex justify-between">
                    <span className="font-medium">{r.name} → {r.target_name}</span>
                    <span className="text-gray-500">{r.source} · {r.effect} · p{r.priority}</span>
                  </div>
                  {h && h.verdict !== 'healthy' && (
                    <div className={`mt-1 text-xs ${h.verdict === 'dead' ? 'text-red-700' : 'text-amber-700'}`}>
                      {h.verdict === 'dead' ? 'dead rule' : 'always shadowed'} — {h.detail}
                    </div>
                  )}
                  <pre className="mt-1 text-xs text-gray-600 overflow-auto">{JSON.stringify(r.criteria)}</pre>
                </li>
              );
            })}
            {(bySlot.get(s.key) ?? []).length === 0 && <li className="text-sm text-gray-500">No rules.</li>}
          </ul>
        </section>
      ))}

      <AiAuthor companyId={company.id} slots={slots} targets={targets} />
      <RuleForm companyId={company.id} slots={slots} targets={targets} rules={rules} systemAt={systemAt} />
    </main>
  );
}

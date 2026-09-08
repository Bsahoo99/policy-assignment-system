export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { getDb, getClock } from '../src/runtime';
import { NewHirePreview } from './components/NewHirePreview';

export default async function Home({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const sp = await searchParams;
  const db = await getDb();
  const now = getClock().now();
  const systemAt = typeof sp.system_at === 'string' ? new Date(sp.system_at) : now;
  const validAt = typeof sp.valid_at === 'string' ? new Date(sp.valid_at) : now;
  const { rows: companies } = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM companies ORDER BY name',
  );
  const company = companies[0];
  if (!company) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-bold">Policy Assignment System</h1>
        <p className="mt-4">No company — run <code className="bg-gray-100 px-1 rounded">npm run seed</code> or POST /api/companies.</p>
      </main>
    );
  }

  const [{ rows: employees }, { rows: slots }, { rows: targets }, { rows: rules }, { rows: groups }] = await Promise.all([
    db.query<{ id: string; first_name: string; last_name: string; email: string }>(
      'SELECT id, first_name, last_name, email FROM employees WHERE company_id = $1 ORDER BY last_name',
      [company.id],
    ),
    db.query<{ id: string; key: string; display_name: string; cardinality: string; target_type: string }>(
      'SELECT id, key, display_name, cardinality, target_type FROM assignment_slots WHERE company_id = $1 ORDER BY key',
      [company.id],
    ),
    db.query<{ id: string; target_type: string; display_name: string; slotKey: string }>(
      `SELECT at.id, at.target_type, at.display_name, s.key AS "slotKey"
       FROM assignment_targets at
       JOIN assignment_slots s ON s.company_id = at.company_id AND s.target_type = at.target_type
       WHERE at.company_id = $1
       ORDER BY at.display_name`,
      [company.id],
    ),
    db.query<{ name: string; source: string; effect: string; priority: number }>(
      `SELECT DISTINCT ON (rule_id) name, source, effect, priority FROM assignment_rules
       WHERE company_id = $1 AND system @> $2::timestamptz AND valid @> $3::timestamptz
       ORDER BY rule_id, lower(valid) DESC`,
      [company.id, systemAt.toISOString(), validAt.toISOString()],
    ),
    db.query<{ key: string; kind: string }>(
      'SELECT key, kind FROM groups WHERE company_id = $1 ORDER BY key',
      [company.id],
    ),
  ]);

  return (
    <main className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold">{company.name}</h1>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Employees</h2>
        <ul className="mt-2 space-y-2">
          {employees.map((e) => (
            <li key={e.id} className="border rounded p-3">
              <Link href={`/employees/${e.id}`} className="text-blue-600 hover:underline">
                {e.first_name} {e.last_name}
              </Link>
              <span className="ml-2 text-sm text-gray-500">{e.email}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Slots</h2>
        <ul className="mt-2 grid grid-cols-2 gap-2">
          {slots.map((s) => (
            <li key={s.key} className="border rounded p-2 text-sm">
              <strong>{s.key}</strong> <span className="text-gray-500">({s.cardinality} → {s.target_type})</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">
          <Link href="/rules" className="hover:underline">Rules</Link>
        </h2>
        <ul className="mt-2 space-y-1">
          {rules.map((r, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">{r.name}</span>
              <span className="ml-2 text-gray-500">{r.source} · {r.effect} · p{r.priority}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">
          <Link href="/groups" className="hover:underline">Groups</Link>
        </h2>
        <ul className="mt-2 space-y-1">
          {groups.map((g) => (
            <li key={g.key} className="text-sm">{g.key} <span className="text-gray-500">({g.kind})</span></li>
          ))}
        </ul>
      </section>

      <NewHirePreview companyId={company.id} validAt={validAt} systemAt={systemAt} slots={slots} targets={targets} />
    </main>
  );
}

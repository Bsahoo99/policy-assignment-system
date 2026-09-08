import { getDb, getClock } from '../../../src/runtime';
import { computeHealthReport } from '../../../src/health';

/**
 * GET /api/health?company_id=
 *
 * Rule health over the current population: dead rules, always-shadowed rules,
 * equal-(source, priority) collisions, and unfilled exactly_one slots. Computed
 * by running the same resolution pass reconciliation runs — the verdicts the
 * engine already produces, aggregated instead of discarded.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get('company_id');
  if (!companyId) return Response.json({ error: 'company_id required' }, { status: 400 });
  const at = url.searchParams.get('at');
  const asOf = at ? new Date(at) : getClock().now();
  const db = await getDb();
  return Response.json(await computeHealthReport(db, companyId, asOf));
}

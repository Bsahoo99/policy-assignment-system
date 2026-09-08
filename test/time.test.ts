import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { localInputToIso, isoToLocalInput } from '../app/components/time';

describe('dual-time controls are UTC end to end (K3)', () => {
  it('test_utc_input_round_trips_without_local_shift', () => {
    expect(localInputToIso('2026-09-01T00:00')).toBe('2026-09-01T00:00:00.000Z');
    expect(isoToLocalInput('2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00');
    expect(isoToLocalInput(localInputToIso('2026-09-01T00:00'))).toBe('2026-09-01T00:00');
  });

  it('test_utc_round_trip_is_stable_under_tz_america_los_angeles', () => {
    // Run the helpers in a subprocess whose timezone is Los Angeles. If the
    // input were parsed as local time, 2026-09-01T00:00 would come back as
    // 2026-09-01T07:00:00.000Z. It must not.
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const code = [
      `import { localInputToIso, isoToLocalInput } from './app/components/time';`,
      `console.log(localInputToIso('2026-09-01T00:00'));`,
      `console.log(isoToLocalInput('2026-09-01T00:00:00.000Z'));`,
    ].join('\n');
    const out = execFileSync(tsx, ['-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: 'America/Los_Angeles' },
      encoding: 'utf8',
    }).trim().split('\n');
    expect(out).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-01T00:00']);
  });
});

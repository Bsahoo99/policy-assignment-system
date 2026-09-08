'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isoToLocalInput, localInputToIso } from './time';

export function DualTimeControls() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const validAtParam = searchParams.get('valid_at') ?? '';
  const systemAtParam = searchParams.get('system_at') ?? '';
  const [validAt, setValidAt] = useState(validAtParam);
  const [systemAt, setSystemAt] = useState(systemAtParam);

  useEffect(() => {
    setValidAt(validAtParam);
    setSystemAt(systemAtParam);
  }, [validAtParam, systemAtParam]);

  function update(param: 'valid_at' | 'system_at', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(param, localInputToIso(value)); else params.delete(param);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-3 text-xs text-gray-600">
      <label className="flex items-center gap-1">
        valid at (UTC):
        <input
          type="datetime-local"
          value={validAt ? isoToLocalInput(validAt) : ''}
          onChange={(e) => { setValidAt(e.target.value); update('valid_at', e.target.value); }}
          className="border rounded px-1 py-0.5"
        />
      </label>
      <label className="flex items-center gap-1">
        system at (UTC):
        <input
          type="datetime-local"
          value={systemAt ? isoToLocalInput(systemAt) : ''}
          onChange={(e) => { setSystemAt(e.target.value); update('system_at', e.target.value); }}
          className="border rounded px-1 py-0.5"
        />
      </label>
    </div>
  );
}

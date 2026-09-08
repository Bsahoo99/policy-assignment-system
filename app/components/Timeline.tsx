'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';

export interface TimelineSegment {
  target: string;
  ruleName: string;
  from: string; // ISO
  to: string | null; // ISO, null = open-ended
  summary: string; // the explain-text line for the winning rule
}

export interface TimelineBand {
  slot: string;
  segments: TimelineSegment[];
}

/**
 * Assign each segment to the first sub-row where it does not overlap the
 * previous segment, so concurrent assignments (a `many` slot can hold several)
 * stack vertically instead of hiding each other.
 */
function computeLanes(segments: TimelineSegment[], axisMax: number): TimelineSegment[][] {
  const lanes: TimelineSegment[][] = [];
  for (const s of [...segments].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const f = Date.parse(s.from);
    let lane = lanes.findIndex((l) => {
      const last = l[l.length - 1];
      const lastU = last.to ? Date.parse(last.to) : axisMax;
      return lastU <= f;
    });
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push(s);
  }
  return lanes;
}

/**
 * One horizontal band per slot; each assignment is a segment across its valid
 * range. Segments that overlap in time (possible in `many` slots) stack onto
 * separate sub-rows so the band never hides an assignment.
 *
 * The solid marker is the valid "as of" instant and is draggable — releasing it
 * writes `valid_at` into the URL, which re-renders the whole page at that
 * instant. The dashed marker is the system instant; the header's system control
 * redraws the bands under a different belief.
 */
export function AssignmentTimeline({
  bands,
  axisMin,
  axisMax,
  validAt,
  systemAt,
}: {
  bands: TimelineBand[];
  axisMin: number;
  axisMax: number;
  validAt: string;
  systemAt: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragAt, setDragAt] = useState<number | null>(null);

  const span = Math.max(axisMax - axisMin, 1);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - axisMin) / span) * 100));
  const markerAt = dragAt ?? Date.parse(validAt);

  const palette = ['bg-blue-200', 'bg-green-200', 'bg-purple-200', 'bg-amber-200', 'bg-pink-200', 'bg-cyan-200'];
  const colorBy = new Map<string, string>();
  const colorFor = (t: string) => {
    if (!colorBy.has(t)) colorBy.set(t, palette[colorBy.size % palette.length]);
    return colorBy.get(t)!;
  };

  function timeAt(clientX: number): number {
    const el = trackRef.current;
    if (!el) return axisMin;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return axisMin + frac * span;
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragAt(timeAt(e.clientX));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragAt !== null) setDragAt(timeAt(e.clientX));
  }
  function onPointerUp() {
    if (dragAt === null) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('valid_at', new Date(dragAt).toISOString());
    setDragAt(null);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div>
      <p className="mt-1 text-xs text-gray-500">
        Believed at system {systemAt.slice(0, 10)} (UTC) — move the header system control to redraw.
        Drag the red marker to change the valid-as-of instant; currently{' '}
        {new Date(markerAt).toISOString().slice(0, 10)}. Dashed: system {systemAt.slice(0, 10)}.
      </p>
      <div className="mt-2 flex gap-2">
        {/* Label column sits outside the measured track — measuring the whole
            container would offset every click right by the label width. */}
        <div className="w-28 shrink-0 space-y-1.5">
          {bands.map((band) => (
            <div key={band.slot} className="space-y-0.5">
              {computeLanes(band.segments, axisMax).map((_, li) => (
                <div key={li} className="flex h-6 items-center text-xs font-medium text-gray-700">
                  {li === 0 ? band.slot : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div
          ref={trackRef}
          className="flex-1 space-y-1.5 cursor-ew-resize select-none touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {bands.map((band) => {
            const lanes = computeLanes(band.segments, axisMax);
            return (
              <div key={band.slot} className="space-y-0.5">
                {lanes.map((lane, li) => (
                  <div key={li} className="relative h-6 rounded bg-gray-100">
                    {lane.map((s, i) => {
                      const l = Date.parse(s.from);
                      const u = s.to ? Date.parse(s.to) : axisMax;
                      return (
                        <div
                          key={i}
                          className={`absolute top-0 bottom-0 ${colorFor(s.target)} border-r border-white`}
                          style={{ left: `${pct(l)}%`, width: `${Math.max(pct(u) - pct(l), 0.75)}%` }}
                          title={`${s.target} [${s.from.slice(0, 10)}, ${s.to?.slice(0, 10) ?? '∞'}) — ${s.ruleName}: ${s.summary}`}
                        >
                          <span className="absolute inset-0 flex items-center truncate px-1 text-[10px] text-gray-800">
                            {s.target}
                          </span>
                        </div>
                      );
                    })}
                    <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: `${pct(markerAt)}%` }} />
                    <div className="pointer-events-none absolute top-0 bottom-0 w-px border-l border-dashed border-gray-600" style={{ left: `${pct(Date.parse(systemAt))}%` }} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-gray-400">
        <span>{new Date(axisMin).toISOString().slice(0, 10)}</span>
        <span>{new Date(axisMax).toISOString().slice(0, 10)}</span>
      </div>
    </div>
  );
}

/**
 * The dual-time controls are UTC end to end. A `datetime-local` input yields a
 * `YYYY-MM-DDTHH:mm` string with no zone; `new Date(v)` would parse it as LOCAL
 * time, which shifted a Los Angeles user's date by seven hours (K3). We append
 * ':00Z' so the instant is interpreted as UTC, and display `toISOString()`
 * (also UTC) so what you type is what you get.
 */
export function localInputToIso(v: string): string {
  return new Date(`${v.length === 16 ? `${v}:00` : v}Z`).toISOString();
}

export function isoToLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

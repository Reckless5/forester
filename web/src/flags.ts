// Flags an owner can put on a parcel.

export const FLAGS = [
  { type: 'kaefer', label: 'Käferbefall', color: '#c62828' },
  { type: 'windwurf', label: 'Windwurf', color: '#ef6c00' },
  { type: 'durchforsten', label: 'Durchforsten', color: '#6a1b9a' },
] as const;

export type FlagType = (typeof FLAGS)[number]['type'];

export interface Flag {
  type: FlagType;
  /** When the flag was set (ISO date-time). */
  since: string;
}

export const flagDef = (type: FlagType) => FLAGS.find((f) => f.type === type)!;

/** Flags in the fixed order above, so they always show the same way. */
export const sortFlags = (flags: Flag[] = []) =>
  FLAGS.map((d) => flags.find((f) => f.type === d.type)).filter((f): f is Flag => !!f);

export const formatSince = (iso: string) =>
  new Date(iso).toLocaleDateString('de-AT', { day: 'numeric', month: 'numeric', year: 'numeric' });

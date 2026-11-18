// What grows on a field: common Austrian field crops, plus meadow and pasture.
// A crop is stored per year, because it changes with the crop rotation.

export interface Crop {
  type: CropType;
  year: number;
  /** Free text for "Sonstiges", or a variety/remark. */
  note?: string;
}

export const CROP_GROUPS = [
  {
    label: 'Getreide',
    crops: [
      { type: 'weizen', label: 'Weizen' },
      { type: 'dinkel', label: 'Dinkel' },
      { type: 'gerste', label: 'Gerste' },
      { type: 'roggen', label: 'Roggen' },
      { type: 'triticale', label: 'Triticale' },
      { type: 'hafer', label: 'Hafer' },
      { type: 'koernermais', label: 'Körnermais' },
      { type: 'silomais', label: 'Silomais' },
    ],
  },
  {
    label: 'Öl- und Eiweißpflanzen',
    crops: [
      { type: 'raps', label: 'Raps' },
      { type: 'sonnenblume', label: 'Sonnenblume' },
      { type: 'soja', label: 'Sojabohne' },
      { type: 'oelkuerbis', label: 'Ölkürbis' },
      { type: 'erbse', label: 'Körnererbse' },
      { type: 'ackerbohne', label: 'Ackerbohne' },
    ],
  },
  {
    label: 'Hackfrüchte und Gemüse',
    crops: [
      { type: 'zuckerruebe', label: 'Zuckerrübe' },
      { type: 'kartoffel', label: 'Kartoffel' },
      { type: 'gemuese', label: 'Feldgemüse' },
    ],
  },
  {
    label: 'Futter und Grünland',
    crops: [
      { type: 'wiese', label: 'Wiese (Mähwiese)' },
      { type: 'weide', label: 'Weide' },
      { type: 'kleegras', label: 'Kleegras' },
      { type: 'luzerne', label: 'Luzerne' },
    ],
  },
  {
    label: 'Sonstiges',
    crops: [
      { type: 'brache', label: 'Brache' },
      { type: 'sonstiges', label: 'Sonstiges' },
    ],
  },
] as const;

export type CropType = (typeof CROP_GROUPS)[number]['crops'][number]['type'];

const LABELS = new Map<string, string>(CROP_GROUPS.flatMap((g) => g.crops.map((c) => [c.type, c.label] as const)));

export const cropLabel = (c: Crop) =>
  c.type === 'sonstiges' && c.note ? c.note : (LABELS.get(c.type) ?? c.type);

/** e.g. "Körnermais 2026", "Wiese (Mähwiese) 2026". */
export const cropText = (c: Crop) => `${cropLabel(c)} ${c.year}`;

export const isCropType = (t: string): t is CropType => LABELS.has(t);

/** Crop year for a new entry: the current calendar year. */
export const thisYear = () => new Date().getFullYear();

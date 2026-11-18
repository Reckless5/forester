// User settings, kept in the browser.

import type { LngLat } from './geo';

export interface Settings {
  /** Draw parcels that contain forest (map menu "Wälder anzeigen"). */
  showForest: boolean;
  /** Draw parcels that contain fields (map menu "Felder anzeigen"). */
  showFields: boolean;
  /** Hand-placed position for testing; overrides GPS while set. */
  debugPos?: LngLat;
}

const KEY = 'forester.settings.v1';
const DEFAULTS: Settings = { showForest: true, showFields: false };

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();

export const settings = {
  get: () => current,
  set(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    if (current.debugPos === undefined) delete current.debugPos;
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* private mode etc. – settings just won't persist */
    }
  },
};

import { useState } from 'react';
export function usePreference<T>(
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`reisa.ui.${key}`);
      const parsed: unknown = raw === null ? fallback : JSON.parse(raw);
      return validate(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: T | ((previous: T) => T)) =>
    setValue((previous) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      try {
        localStorage.setItem(`reisa.ui.${key}`, JSON.stringify(resolved));
      } catch {
        /* UI remains usable when storage is unavailable. */
      }
      return resolved;
    });
  return [value, update] as const;
}
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
export type Theme = 'system' | 'light' | 'dark';
export const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A value as plain text: strings and numbers as they are, anything else empty. */
export function plain(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
}

/** A label from a theme or field schema: a string, or one per locale. */
export function label(value: string | Record<string, string> | undefined, locale: string): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return value[locale] ?? value.en ?? Object.values(value)[0] ?? '';
}

// Optional ABI v1 registration extension: read-only property panels and
// edit-command interception for cached `TCH_*` records.
//
// The host loads the module, calls `register(host)` once, and then asks the
// registered handlers; the plugin never imports host source and never touches
// `cad-db`. Panels are display-only descriptors rendered by the host.
//
// The record cache below keeps the `VendorRecord[]` parsed by `decode` alive
// between calls. It is bounded by the records frame limit (<= 64 MiB); every
// stream is a `Uint8Array` view into that one `ArrayBuffer`, so the cache does
// not copy payload bytes, but it does keep the whole frame reachable until the
// next `decode` replaces it.

import { decodeOpening } from './opening.ts';
import { parseColumn } from './column.ts';
import { parseText } from './text.ts';
import type { Point3 } from './bit-reader.ts';
import type { VendorRecord } from './types.ts';
import { parseWall } from './wall.ts';

// ---------------------------------------------------------------------------
// Host-facing structural types (the plugin never imports host source)
// ---------------------------------------------------------------------------

export interface PluginSelectionRow {
  key: string; value: string | null; group: string;
  mixed: boolean; editable: boolean; kind: string; options: string[];
}

export interface PluginSelection {
  count: number; empty: boolean; rows: PluginSelectionRow[];
}

export interface PluginPropertyRow { key: string; value: string }
export interface PluginPropertyGroup { key: string; rows: PluginPropertyRow[] }
export interface PluginPropertyPanel { kind: string; handle: string; groups: PluginPropertyGroup[] }

export interface PluginCommandRequest { command: string; selection: PluginSelection }
export type PluginCommandDecision = { handled: true; messageKey: string } | null;

export interface VendorPluginHost {
  on(event: 'properties', handler: (selection: PluginSelection) => PluginPropertyPanel | null): void;
  on(event: 'command', handler: (request: PluginCommandRequest) => PluginCommandDecision | null): void;
  on(event: 'cad-status', handler: (status: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Record cache (owned by `decode` in index.ts)
// ---------------------------------------------------------------------------

const recordByHandle = new Map<bigint, VendorRecord>();

/** Replace the cache with the records parsed from the last successful decode. */
export function replaceRecordCache(records: readonly VendorRecord[]): void {
  recordByHandle.clear();
  for (const record of records) {
    if (!recordByHandle.has(record.handle)) recordByHandle.set(record.handle, record);
  }
}

/** Empty the cache; `decode` calls this before parsing and on any throw. */
export function clearRecordCache(): void {
  recordByHandle.clear();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Commands for which a selected TCH record has no supported editor yet. */
const EDIT_COMMANDS = new Set([
  'MOVE', 'COPY', 'ERASE', 'ROTATE', 'SCALE', 'MIRROR', 'STRETCH',
  'TRIM', 'EXTEND', 'OFFSET', 'EXPLODE', 'ARRAY', 'PEDIT', 'FILLET', 'CHAMFER',
]);

/**
 * Register handlers with the host. Registration failures are not fatal: the
 * host treats a missing/throwaway provider as "no provider" and keeps the
 * built-in property palette and command path.
 */
export function register(host: VendorPluginHost): void {
  if (!host || typeof host.on !== 'function') return;
  try {
    host.on('properties', propertiesHandler);
  } catch {
    // No provider; the host falls back to its own palette.
  }
  try {
    host.on('command', commandHandler);
  } catch {
    // No provider; the host keeps its normal command path.
  }
}

/** Synchronous, never throws: `null` means "not handled, pass through". */
export function propertiesHandler(selection: PluginSelection): PluginPropertyPanel | null {
  try {
    return buildPanel(selection);
  } catch {
    return null;
  }
}

/** Synchronous, never throws: `null` means "let the command through". */
export function commandHandler(request: PluginCommandRequest): PluginCommandDecision | null {
  try {
    if (!request || typeof request.command !== 'string') return null;
    if (!EDIT_COMMANDS.has(request.command.toUpperCase())) return null;
    if (singleRecord(request.selection) === null) return null;
    return { handled: true, messageKey: 'vendor.editing.unsupported' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Selection resolution
// ---------------------------------------------------------------------------

/**
 * Resolve only a single, non-empty selection whose `handle` row is a plain
 * hex u64 that exists in the last decoded records. Multi-selection has no
 * per-entity list in the wire status, so it is always pass-through.
 */
function singleRecord(selection: PluginSelection | null | undefined): VendorRecord | null {
  if (!selection || selection.count !== 1 || selection.empty) return null;
  if (!Array.isArray(selection.rows)) return null;
  const row = selection.rows.find(
    candidate => candidate !== null && candidate !== undefined && candidate.key === 'handle',
  );
  if (!row || row.mixed || typeof row.value !== 'string') return null;
  const value = row.value.trim();
  if (value.length === 0 || value.length > 16 || !/^[0-9a-fA-F]+$/.test(value)) return null;
  let handle: bigint;
  try {
    handle = BigInt(`0x${value}`);
  } catch {
    return null;
  }
  return recordByHandle.get(handle) ?? null;
}

/** First non-mixed row with `key`, or `null`. */
function selectionValue(selection: PluginSelection, key: string): string | null {
  if (!Array.isArray(selection.rows)) return null;
  const row = selection.rows.find(
    candidate => candidate !== null && candidate !== undefined && candidate.key === key,
  );
  if (!row || row.mixed || typeof row.value !== 'string') return null;
  return row.value;
}

// ---------------------------------------------------------------------------
// Panel building
// ---------------------------------------------------------------------------

function buildPanel(selection: PluginSelection): PluginPropertyPanel | null {
  const record = singleRecord(selection);
  if (record === null) return null;
  const handle = handleHex(record.handle);
  const groups: PluginPropertyGroup[] = [identityGroup(record, selection)];
  const extra = classGroup(record);
  if (extra !== null) groups.push(extra);
  return { kind: record.className, handle, groups };
}

function identityGroup(record: VendorRecord, selection: PluginSelection): PluginPropertyGroup {
  const rows: PluginPropertyRow[] = [
    { key: 'identity.class', value: record.className },
    { key: 'identity.handle', value: handleHex(record.handle) },
    { key: 'identity.layer', value: selectionValue(selection, 'layer') ?? 'unknown' },
    { key: 'identity.source', value: sourceValue(record.source) },
    { key: 'identity.dwg_version', value: String(record.dwgVersion) },
    {
      key: 'identity.record_bytes',
      value: String(record.main.length + record.text.length + record.handleStream.length),
    },
    { key: 'identity.references', value: String(record.referenceCount ?? 0) },
  ];
  return { key: 'identity', rows };
}

function classGroup(record: VendorRecord): PluginPropertyGroup | null {
  let key: 'geometry' | 'text';
  let rows: PluginPropertyRow[] | null;
  switch (record.className) {
    case 'TCH_WALL':
      key = 'geometry';
      rows = wallRows(record);
      break;
    case 'TCH_COLUMN':
      key = 'geometry';
      rows = columnRows(record);
      break;
    case 'TCH_OPENING':
      key = 'geometry';
      rows = openingRows(record);
      break;
    case 'TCH_TEXT':
    case 'TCH_MTEXT':
      key = 'text';
      rows = textRows(record);
      break;
    default:
      return null;
  }
  return rows !== null && rows.length > 0 ? { key, rows } : null;
}

function wallRows(record: VendorRecord): PluginPropertyRow[] | null {
  const wall = safeParse(() => parseWall(record, new Map()));
  if (wall === null) return null;
  const rows: PluginPropertyRow[] = [];
  pushPoint(rows, 'wall.start', wall.start.x, wall.start.y, wall.start.z);
  pushPoint(rows, 'wall.end', wall.end.x, wall.end.y, wall.end.z);
  pushNumber(rows, 'wall.length', wall.length);
  pushNumber(rows, 'wall.width', wall.left + wall.right);
  pushNumber(rows, 'wall.thickness_left', wall.left);
  pushNumber(rows, 'wall.thickness_right', wall.right);
  pushNumber(rows, 'wall.height', wall.height);
  pushNumber(rows, 'wall.angle', wallDirectionDegrees(wall.start, wall.end));
  pushNumber(rows, 'wall.material', wall.material);
  pushNumber(rows, 'wall.insulation', wall.insulation);
  pushNumber(rows, 'wall.openings', wall.openings);
  return rows;
}

/** Plan direction from `start` to `end` in degrees from +X, normalized to `[0, 360)`. */
function wallDirectionDegrees(start: Point3, end: Point3): number {
  const degrees = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

function columnRows(record: VendorRecord): PluginPropertyRow[] | null {
  const column = safeParse(() => parseColumn(record, new Map()));
  if (column === null) return null;
  const rows: PluginPropertyRow[] = [];
  pushPoint(rows, 'column.position', column.position.x, column.position.y, column.position.z);
  pushNumber(rows, 'column.vertices', column.vertices.length);
  pushNumber(rows, 'column.height', column.height);
  return rows;
}

function textRows(record: VendorRecord): PluginPropertyRow[] | null {
  const text = safeParse(() => parseText(record, new Map()));
  if (text === null) return null;
  const rows: PluginPropertyRow[] = [];
  if (text.text.length > 0) rows.push({ key: 'text.content', value: text.text });
  pushNumber(rows, 'text.height', text.height);
  pushNumber(rows, 'text.rotation', text.rotation);
  return rows;
}

function openingRows(record: VendorRecord): PluginPropertyRow[] | null {
  const opening = safeParse(() => decodeOpening(record, new Map()));
  if (opening === null) return null;
  const rows: PluginPropertyRow[] = [];
  pushNumber(rows, 'opening.width', opening.width);
  rows.push({ key: 'opening.wall_handle', value: handleHex(opening.wall) });
  return rows;
}

function safeParse<T>(parse: () => T | null): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic formatting
// ---------------------------------------------------------------------------

/**
 * Up to 3 decimals with trailing zeros trimmed, never `NaN`/`Infinity`.
 * Non-finite values return `null` and the caller omits that row; layer/source
 * fall back to the literal `unknown` because they are not numeric.
 */
function formatNumber(value: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const trimmed = value.toFixed(3).replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

function pushNumber(rows: PluginPropertyRow[], key: string, value: number): void {
  const text = formatNumber(value);
  if (text !== null) rows.push({ key, value: text });
}

function pushPoint(rows: PluginPropertyRow[], key: string, x: number, y: number, z: number): void {
  const px = formatNumber(x);
  const py = formatNumber(y);
  const pz = formatNumber(z);
  if (px === null || py === null || pz === null) return;
  rows.push({ key, value: `${px}, ${py}, ${pz}` });
}

function handleHex(handle: bigint): string {
  return handle.toString(16).toUpperCase();
}

function sourceValue(source: number | undefined): string {
  if (source === 1) return 'proxy-entity';
  if (source === undefined || source === 0) return 'unknown-entity';
  return 'unknown';
}

# tangent-ts

Tianzheng (`TCH_*`) vendor-record decoder plugin for
[yacr](https://github.com/zenglanmu/yacr), the Rust CAD viewer/measurement
system. `tangent` is the English brand name of Tianzheng (天正).

The plugin runs **inside the WebView** as a module script loaded by the host. It
never touches `cad-db`, the filesystem, or Tauri IPC. Its job is to turn the
host's extracted vendor records into display-only derived primitives and,
optionally, to expose read-only `TCH_*` property panels and edit-command
refusals through the registration extension below.

## Contract (ABI v1)

```ts
export const abiVersion: 1;
export function decode(records: ArrayBuffer): ArrayBuffer;

// Optional extension; hosts that do not call it keep only `decode`.
export function register(host: VendorPluginHost): void;
```

The built module also registers itself on
`globalThis.__YACR_VENDOR_PLUGIN__ = { abiVersion, decode, register }`; the host
validates that global before use.

The binary frames are specified in [docs/abi-v1.md](docs/abi-v1.md). The result
frame contains entity groups and primitives (lines/segments/arcs/circles/text/
block inserts), with `applied` equal to the primitive count.

## Optional registration extension

`register(host)` is synchronous and installs two handlers:

- `properties(selection) -> PluginPropertyPanel | null` — a read-only descriptor
  for the host's property dock. `null` passes through to the built-in palette.
- `command(request) -> { handled: true, messageKey } | null` — `null` lets the
  command through. The plugin refuses the stable edit set (`MOVE`, `COPY`,
  `ERASE`, `ROTATE`, `SCALE`, `MIRROR`, `STRETCH`, `TRIM`, `EXTEND`, `OFFSET`,
  `EXPLODE`, `ARRAY`, `PEDIT`, `FILLET`, `CHAMFER`) when the selection resolves
  to a decoded TCH record; draw commands are never intercepted.

`cad-status` is not required by this plugin, and registration failures are not
fatal (the host behaves as if no provider exists). Both handlers never throw:
malformed or unknown input returns `null`.

Only a **single** selection (`count === 1`, `!empty`) whose `handle` row is a
plain uppercase/lowercase hex u64 is resolved. Multi-selection, missing handles,
`none`, and handles absent from the last decoded records all pass through. The
wire status carries only the intersection of selection rows, not a per-entity
list, so multi-selection panels are a documented limitation.

Panels are display-only: `kind` is the record class, `handle` is uppercase hex,
and groups (`identity`, `geometry`, `text`) carry machine row keys such as
`wall.height` / `text.content`. The host translates `properties.tch.<key>` and
renders the values; the plugin emits no DOM, no HTML and no Chinese literals.
Numeric values use up to 3 decimals with trailing zeros trimmed (`x, y, z` for
points). Non-finite numeric values omit that row; non-numeric fallbacks use the
literal `unknown`.

`decode` caches the parsed `VendorRecord[]` in module scope so these handlers can
resolve a handle. The cache is cleared at the start of every `decode` and left
empty on any throw. Memory is bounded by the records-frame limit (<= 64 MiB):
stream fields are `Uint8Array` views into that frame, so the cache keeps the
buffer alive until the next `decode` but copies no payload bytes.

## Coverage

Current coverage against the real `test-tangent-real.dwg` fixture (10,612 vendor
records; 9,889 entities / 14,911 primitives):

| group | classes |
|---|---|
| structure | `TCH_WALL` (straight walls), `TCH_COLUMN`, `TCH_OPENING` (wall cuts, hole jambs, door/window 2D symbol blocks, threshold lines, band windows, composite groups) |
| text | `TCH_TEXT`, `TCH_MTEXT` |
| annotation | `TCH_ELEVATION`, `TCH_ARROW`, `TCH_MULTILEADER`, `TCH_DRAWINGINDEX`, `TCH_DRAWINGNAME`, `TCH_NORTHTHUMB` |
| dimension | `TCH_DIMENSION2`, `TCH_AXIS_LABEL`, `TCH_RADIUSDIM` |
| stair | `TCH_LINESTAIR`, `TCH_RECTSTAIR` |
| symbol / line work | `TCH_SYMB_SECTION`, `TCH_INDEXPOINTER`, `TCH_CORNER_WINDOW`, `TCH_BLOCK_INSERT`, `TCH_RUPTURE`, `TCH_MODI` |

`TCH_BLOCK_INSERT` and the door/window symbols emit a block reference by
**source handle** (kind 5); the host resolves it through
`DrawingDatabase::block_by_source_handle` and expands the imported block. All 40
distinct handles in the real fixture resolve to imported blocks that have
entities.

Still unsupported and counted explicitly rather than drawn: `TCH_SPACE` (383),
`TCH_WALL` records that fail the verified header/arc layout (157), `TCH_OPENING`
records with an unknown body version or a null wall (70), `TCH_DIMENSION` (35,
the older class; MiniCAD has no decoder for it either), `TCH_SHEET` (1), and
`TCH_ERRORMSG` (1). Records whose class body is valid but has no drawable
geometry land in `vendor.tch.no_display`. The result frame carries a coverage
proof: `decoded + unsupported + no_display == record count`; a mismatch emits
`vendor.tch.unaccounted`.

The class text stream starts with a shared `TDBXDATAMAP_BLOCK_BEGIN_ … _END_`
block; `ClassText` skips it once per record so real labels are emitted instead of
the sentinel (verified: 0 sentinel text primitives in the real result frame).

## Build

```bash
npm ci
npm run check      # tsc --noEmit + rolldown bundle
# or
npm run typecheck
npm run build      # -> dist/index.js (single ES module)
```

`dist/` is build output and is not committed.

## Using it from yacr

The host expects this repository as a git submodule at `plugins/tch`:

```bash
git submodule add https://github.com/zenglanmu/tangent-ts.git plugins/tch
```

yacr's `scripts/build-vendor-plugin.sh` bundles `plugins/tch/src/index.ts` with
its own `rolldown` into `plugins/tch/dist/index.js` and copies that single ES
module to `apps/desktop-ui/public/plugins/tch.js`, which every carrier's Vite
build embeds as `dist/plugins/tch.js`. The host only assumes the build command
above and the ABI v1 contract; it does not import plugin source at runtime.

## Tests and evidence

Integration/contract tests live in the host repository:

- `apps/desktop-ui/test/vendor-plugin.test.ts` — frame header, token/generation
  echo, records-frame validation, primitive result frame, and the base-6
  `TCH_WALL` / `TCH_COLUMN` decoders.
- `apps/desktop-ui/test/stacking-regression.test.ts` — display ordering with
  vendor-derived primitives.

These tests import the plugin source directly, so they keep running against
whatever revision the submodule points at.

Runtime evidence is bounded: the full scene was loaded by a real-GPU Linux
`native-below` run (Quadro P620, Vulkan) with `test-tangent-real.dwg`. Windows,
macOS, Android, and Web remain compile/contract only. Synthetic fixtures and
software rendering are not evidence of vendor compatibility, real-GPU behavior,
or performance.

## Scope and limitations

- This is not a general DWG decoder. It decodes only vendor records that the
  host already extracted and validated; missing cached geometry cannot be
  recovered by the plugin.
- Unknown layouts are reported as `vendor.tch.*` diagnostics, never guessed into
  drawable geometry.
- Geometry produced here is a display-only derived representation. `cad-db`
  remains the single source of truth.

## License

AGPL-3.0-only, same as yacr. See [LICENSE](LICENSE).

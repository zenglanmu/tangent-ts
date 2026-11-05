# ABI v1 binary frames

All fields are little-endian. `u64` is read as `bigint`; coordinates are IEEE-754
`f64`.

## Records frame (host → plugin)

```
u32 magic = 0x59414E44 ("YAND")
u32 abi   = 1
u64 token
u64 generation
u32 record_count
per record:
  u16 class_len, class bytes
  u32 dwg_version          // 1027 = AC1027
  u8  source               // 0 = UnknownEntity, 1 = ProxyEntity
  u64 handle
  u32 main_bits, u32 main_len, main bytes
  u32 text_bits, u32 text_len, text bytes
  u32 handle_bits, u32 handle_len, handle bytes
  u32 main_skip_bits, u32 text_skip_bits, u32 handle_skip_bits
  u32 reference_count, u64 references...
```

`*_skip_bits` is the number of bits the common entity header consumes in each
stream. The plugin starts reading the `TCH_*` class body at those offsets. For
proxy records `main`/`text` already are the class body, so all three skips are 0.

## Result frame (plugin → host)

```
u32 magic = 0x59414E52 ("YANR")
u32 abi   = 1
u64 token
u64 generation
u32 status            // 0 ok, 1 unsupported
u32 applied           // must equal the total number of primitives below
u32 diagnostic_count  // <= 16
per diagnostic: u16 len, UTF-8 bytes   // len <= 512
u32 entity_count
per entity:
  u64 handle
  u32 primitive_count
  per primitive:
    u8 kind
    0 = connected lines: u32 point_count, point_count * (f64 x, f64 y, f64 z)
    1 = segments:        u32 point_count (even), point_count * (f64 x, f64 y, f64 z)
    2 = arc:             f64 cx, cy, cz, radius, start_angle, sweep
    3 = circle:          f64 cx, cy, cz, radius
    4 = text:            f64 x, y, z, height, rotation, wrap_width (0 = none),
                         u8 attachment (1..9), u16 text_len, UTF-8 bytes
    5 = block insert:    u64 block_handle, f64 ox, oy, oz,
                         f64 sx, sy, sz, f64 rotation
```

Limits: records frame <= 64 MiB; result <= 4 MiB; diagnostics <= 16 entries of
<= 512 B; `applied` <= 2,000,000; total primitives <= 2,000,000; points in one
primitive <= 1,000,000.

The host enforces `applied == primitive_count`. A pass with records that returns
`status=0, applied=0` is rejected as `vendor.empty_success`; `status=1` carrying
primitives is rejected as `vendor.unsupported_with_primitives`. Truncation,
trailing bytes, non-finite coordinates, mismatched magic/ABI/token/generation,
and non-UTF-8 diagnostics are rejected rather than repaired.

## Coverage proof

Every input record must end up in exactly one bucket: decoded, unsupported, or
valid-but-not-drawable (`no_display`). The plugin emits
`vendor.tch.unaccounted` when the three counts do not sum to `record_count`.

## Optional registration extension

ABI stays **1** and neither frame layout changes. The module may additionally
export and expose on `globalThis.__YACR_VENDOR_PLUGIN__`:

```ts
export function register(host: VendorPluginHost): void;
```

The host calls `register` at most once at startup. A missing export, a throwing
`register`, or a handler returning `null` is “no provider”: decoding is never
blocked and the host keeps its built-in property palette / command path.

Events consumed by this plugin:

- `properties(selection)` → `PluginPropertyPanel | null`. The panel carries
  `kind` (record class), `handle` (uppercase hex), and groups
  `identity`, `geometry`, `text` with machine row keys (`identity.class`,
  `identity.handle`, `identity.layer`, `identity.source`,
  `identity.dwg_version`, `identity.record_bytes`, `identity.references`,
  `wall.*`, `column.*`, `text.*`, `opening.*`). The host translates
  `properties.tch.<key>`; unknown keys fall back to the raw key. The plugin
  emits no HTML, DOM, or localized text.
- `command(request)` → `{ handled: true, messageKey } | null`. For a resolved
  TCH record and an edit command (`MOVE`, `COPY`, `ERASE`, `ROTATE`, `SCALE`,
  `MIRROR`, `STRETCH`, `TRIM`, `EXTEND`, `OFFSET`, `EXPLODE`, `ARRAY`,
  `PEDIT`, `FILLET`, `CHAMFER`) it refuses with
  `vendor.editing.unsupported`. Draw commands are not intercepted.
- `cad-status` is optional and unused by this plugin.

Both handlers are synchronous and must not throw; malformed or unknown input
returns `null`. Only a single selection (`count === 1`, `!empty`, non-mixed
`handle` row with a hex u64) is resolved against records cached by the last
`decode`. Multi-selection is pass-through because the wire status carries only
the intersection of selection rows, not a per-entity list.

Numeric panel values use up to 3 decimals with trailing zeros trimmed; points
are `x, y, z`. Non-finite numbers omit the row, and non-numeric fallbacks are
the literal `unknown`.

`decode` caches the parsed `VendorRecord[]` for handle lookup, clears the cache
at the start of every call, and leaves it empty when it throws. Memory is
bounded by the records-frame limit (<= 64 MiB); record streams are views into
that single `ArrayBuffer`, so the frame stays reachable until the next decode
but is not copied.

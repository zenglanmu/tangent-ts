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

# Isolated archive transport feasibility

Run `python3 scripts/experiments/world-transfer/run.py` on Linux amd64. It downloads
the official Go 1.21.13 toolchain, checks its published SHA-256, and uses the ZIP/gzip
dependency versions pinned by Wings v1.11.13: archiver v4.0.0-alpha.8,
klauspost/compress v1.17.8 and pgzip v1.2.6. Downloads, module cache, temporary files
and `results.json` stay under ignored `mountdata/test-assets/world-transfer-feasibility`.
There are no infrastructure calls, provider credentials, Docker operations or live
game files. The program removes only the individual temporary files/directories it
creates. The cached toolchain and evidence remain for review.

This reproduces the native extraction **read contract**, not an entire running
Wings service. Its handler opens each member, copies through `io.LimitReader` using
the declared expanded size to a real temporary file, and closes without draining
EOF. A control variant drains EOF. The rename probe reproduces the absence check,
a competing empty-directory creation, and Wings' final `renameat` syscall.

The 2026-10-18 local run produced these results:

| Fixture | Native read contract | EOF-drain control |
| --- | --- | --- |
| Valid STORED/DEFLATE ZIP | Accepted | Accepted |
| STORED bad CRC | **Accepted** | Rejected |
| CRC declared zero, nonzero actual CRC | **Accepted** | **Accepted** |
| STORED/DEFLATE size declared too short or zero | **Accepted** | Rejected |
| Size declared too long or truncated body/archive | Rejected | Rejected |
| DEFLATE bad CRC in the tested payload | Rejected | Rejected |
| TAR corrupted payload | **Accepted** | Not applicable |
| TAR.GZ corrupt CRC or missing gzip trailer | **Accepted** | Not applicable |

The directory rename replaced an empty destination created after preflight. A
single same-filesystem rename is atomic, but the preceding absence check does not
provide atomic no-clobber semantics. This is not a production timing measurement.

Native extraction therefore cannot replace application integrity validation, and
changing archive type does not remove that requirement. The selected implementation
emits a normalized ZIP with selected canonical paths and unchanged compressed
member bytes. It validates decoded length, explicit CRC32 (including zero), SHA-256
and the sealed source identity while streaming. No expanded local tree is needed.
It withholds the central directory and EOF until validation completes; the caller
must await both upload acknowledgment and the validation receipt before extraction.

`scripts/dev.sh pnpm exec tsx scripts/experiments/world-transfer/benchmark.ts`
generates 512 random 64-KiB members and measures only local preparation/streaming.
The 2026-10-18 run measured 625 ms for STORED (175 ms preparation, 450 ms verified
stream) and 868 ms for DEFLATE (105 ms preparation, 762 ms verified stream), each
with 32 MiB expanded data. Rounding explains the one-millisecond sum difference.
These are a single synthetic local run, not provider or end-to-end performance
evidence. Each benchmark run deletes only its own uniquely created fixture directory.

Pinned source references:

- [Wings archive callback](https://github.com/pterodactyl/wings/blob/v1.11.13/server/filesystem/compress.go)
- [Wings bounded file writer](https://github.com/pterodactyl/wings/blob/v1.11.13/server/filesystem/filesystem.go)
- [Wings rename implementation](https://github.com/pterodactyl/wings/blob/v1.11.13/internal/ufs/fs_unix.go)
- [Wings dependency versions](https://github.com/pterodactyl/wings/blob/v1.11.13/go.mod)
- [Archiver ZIP callback contract](https://github.com/mholt/archiver/blob/v4.0.0-alpha.8/zip.go)
- [Pinned ZIP checksum reader](https://github.com/klauspost/compress/blob/v1.17.8/zip/reader.go)

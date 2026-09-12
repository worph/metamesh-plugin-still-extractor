# metamesh-plugin-still-extractor

MetaMesh container plugin. Grabs a representative frame out of a local video
file and stores it as a content-addressed JPEG, referenced from the video
record as **`still`**.

```
video file ──ffmpeg seek+decode──► frame ──WebDAV PUT──► /files/plugin/still-extractor/
                                                              │
                                                   midhash256 │
                                                              ▼
                                              meta-core:  still = <cid>
```

## Why

Artwork on a local file otherwise comes from TMDB, and only when a title match
succeeds. `still` (METADATA_KEYS.md §6.1) is the episode-level thumbnail slot —
reserved for a future TMDB season-detail fetch, and until now written by
nobody. This plugin gives it a first writer from the one source that never
404s and never depends on a match: the file itself.

**A still is not a poster.** Nothing gates on it, its absence is not an error,
and this plugin never writes `poster` — a frame grab masquerading as real
artwork would propagate to every peer that replicates the record. If a TMDB
episode still ever lands on the record first, this plugin steps aside.

## What it writes

| Key | Value |
|---|---|
| `still` | midhash256 CID of the extracted JPEG |

Nothing else — in particular **no `stillPath`**. `/files/plugin` is a meta-core
watcher root, so the JPEG gets its own record and CID alias and
`LookupPathByCID` resolves it through the reverse index. See the header comment
in `src/plugin.ts`.

## How a frame is chosen

1. Candidate offsets at 20 / 45 / 70 % of `fileinfo/duration`, clamped 2s away
   from both ends (the head is logos and black, the tail is credits).
2. At each offset, one ffmpeg run with **input seeking** (`-ss` before `-i`, so
   it Range-seeks over WebDAV instead of decoding from zero) and
   `thumbnail=60`, which picks the most representative of the next 60 frames.
3. The encoded JPEG is measured (mean + stddev of a 32×32 grayscale reduction).
   Black, blown-out and flat frames are rejected and the next offset is tried.
4. All candidates rejected → `skipped`, no field written.

The primary video stream is the largest one that **looks like moving video** —
not `0:v:0`, and not simply the largest. ffprobe reports attached cover art as
`codec_type=video`, and a 600×900 cover out-measures a 640×480 film.

## Configuration

Runtime config via meta-sort's plugin API (never `plugins.yml`):

```bash
curl -k -X PUT https://metasort-dev.localhost:8180/api/plugins/still-extractor/config \
  -H "Content-Type: application/json" \
  -d '{"seekPercents":"15,40,65","maxWidth":720,"jpegQuality":3}'
```

| Key | Default | What |
|---|---|---|
| `forceRecompute` | `false` | Re-extract even when `still` is already set |
| `seekPercents` | `"20,45,70"` | Candidate offsets, as percentages of duration |
| `maxWidth` | `640` | Frame is scaled down to at most this width |
| `jpegQuality` | `4` | ffmpeg `-q:v`; lower is better quality |
| `frameTimeoutMs` | `120000` | Hard kill for one ffmpeg grab |

## Development

```bash
pnpm install && pnpm build
docker build -t metamesh-plugin-still-extractor:main .
./test.sh            # unit + fixture tests in a container with ffmpeg
./test.sh --shell    # interactive debugging
```

Depends on `file-info` (for `fileType`) and `ffmpeg` (for `fileinfo/duration`
and the `stream/{n}` table). Runs on the **background** queue.

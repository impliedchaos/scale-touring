"""Re-encode the soundtrack for the web and generate the in-game playlist.

    python3 tools/build_music.py          # runs automatically before `npm run build` / `npm run dev`

Source : assets/songs/*.mp3 (originals, untouched) + assets/songs/tracks.json (title, artist, url, license)
Output : web/public/music/<source name> at 160 kbps CBR, tagged with title/artist
         web/public/music/playlist.json (what the game plays)

Skips tracks whose output is already newer than the source, so it's instant when nothing changed.
Fails if any track is missing from CREDITS.md: everything gets credited.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "songs")
OUT = os.path.join(ROOT, "web", "public", "music")
BITRATE = "160k"

if not os.path.exists(os.path.join(SRC, "tracks.json")):
    # no soundtrack at the moment: nothing to encode (and nothing stale to ship)
    import shutil
    shutil.rmtree(OUT, ignore_errors=True)
    print("build_music: no assets/songs/tracks.json, no music")
    sys.exit(0)

tracks = json.load(open(os.path.join(SRC, "tracks.json"), encoding="utf-8"))
credits = open(os.path.join(ROOT, "CREDITS.md"), encoding="utf-8").read()

missing = [t["title"] for t in tracks if t["title"] not in credits]
if missing:
    sys.exit("build_music: not credited in CREDITS.md (add them, then rebuild):\n  " + "\n  ".join(missing))
unlisted = sorted(set(f for f in os.listdir(SRC) if f.endswith(".mp3")) - {t["source"] for t in tracks})
if unlisted:
    print("build_music: warning, not in tracks.json (skipped): " + ", ".join(unlisted))

os.makedirs(OUT, exist_ok=True)
playlist = []
for t in tracks:
    src, dst = os.path.join(SRC, t["source"]), os.path.join(OUT, t["source"])
    if not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:a",
                        "-c:a", "libmp3lame", "-b:a", BITRATE, "-map_metadata", "-1",
                        "-metadata", f"title={t['title']}", "-metadata", f"artist={t['artist']}",
                        "-id3v2_version", "3", dst], check=True)
        print(f"build_music: {t['source']}: {os.path.getsize(src) / 1e6:.1f} MB -> {os.path.getsize(dst) / 1e6:.1f} MB")
    playlist.append({"file": t["source"], "title": t["title"], "artist": t["artist"]})

with open(os.path.join(OUT, "playlist.json"), "w", encoding="utf-8") as f:
    json.dump(playlist, f, ensure_ascii=False, indent=2)
    f.write("\n")

# drop stale outputs (tracks removed from tracks.json)
keep = {t["source"] for t in tracks} | {"playlist.json"}
for f in os.listdir(OUT):
    if f not in keep:
        os.remove(os.path.join(OUT, f))
        print(f"build_music: removed stale {f}")

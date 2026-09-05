import asyncio
import base64
import json
import os
import re
import threading
import time

import requests

from flask import Flask, jsonify
from flask_cors import CORS
from flask import request

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus
)

app = Flask(__name__)
CORS(app)

# -------------------------
# Track cache
# -------------------------
#
# Re-encoding artwork and re-fetching lyrics on every single poll
# (once a second) is what was actually causing the progress bar to
# lag and jump: it made each /api/current request take anywhere from
# ~100ms to a few seconds, and that variable delay was never
# accounted for on the frontend. We now only redo that expensive
# work when the track actually changes.
_track_cache = {
    "key": None,
    "artwork": None,
    "lyrics": None,
    "syncedLyrics": None,
}


# =============================================================
# WORD-LEVEL LYRIC SYNC (optional, best-effort)
#
# LRC only gives us a timestamp per LINE, not per word - there is
# no API that hands out real word-by-word timing for arbitrary
# tracks. To get actual word-level sync, this records the song's
# own audio as it plays (system loopback - not scraping anything,
# just listening to what's already coming out of your speakers),
# runs it through a local speech model to find when each word is
# spoken, then maps that timing onto the *real* lyrics text from
# lrclib (so what's displayed is always the correct lyrics - only
# the timing comes from the audio).
#
# This whole feature is optional and fails safe at every step:
#   - if the extra packages below aren't installed, it silently
#     never activates
#   - if audio capture, the model, or the alignment step fails for
#     any reason, that track just doesn't get word-level data
#   - the frontend already has its own syllable-based estimate and
#     uses word-level data only when it's actually present - so any
#     failure here is invisible, the app behaves exactly as it does
#     without this feature
#
# Extra dependencies (not required for the rest of the app):
#   pip install soundcard soundfile numpy faster-whisper
#
# The first time it runs it'll download a small speech model
# (needs internet, ~150MB for the "base" model, one-time).
# =============================================================

WORD_SYNC_ENABLED = True

try:
    import numpy as np
    import soundcard as sc
    from faster_whisper import WhisperModel
except Exception as import_error:
    WORD_SYNC_ENABLED = False
    print(
        "Word-level lyric sync is off (optional packages not "
        "installed):",
        repr(import_error)
    )

CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    ".word_sync_cache"
)

_whisper_model = None
_word_cache = {}
_alignment_in_progress = set()

# Updated on every /api/current call so a background recording
# thread can notice the track changed underneath it and bail out
# instead of recording (and aligning) the wrong song's audio.
_now_playing_key = None


def _cache_path(artist, title):
    safe = re.sub(
        r"[^a-zA-Z0-9]+",
        "_",
        f"{artist}_{title}"
    ).strip("_").lower()

    return os.path.join(CACHE_DIR, f"{safe}.json")


def _load_cached_words(artist, title):
    key = (artist, title)

    if key in _word_cache:
        return _word_cache[key]

    path = _cache_path(artist, title)

    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                words = json.load(f)

            _word_cache[key] = words

            return words

        except Exception:
            return None

    return None


def _save_cached_words(artist, title, words):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)

        with open(
            _cache_path(artist, title),
            "w",
            encoding="utf-8"
        ) as f:
            json.dump(words, f)

    except Exception as e:
        print("Could not save word-sync cache:", repr(e))

    _word_cache[(artist, title)] = words


def _get_whisper_model():
    global _whisper_model

    if _whisper_model is None:
        # "base" is a reasonable speed/accuracy tradeoff on CPU.
        # "tiny" is faster but less accurate; "small"/"medium" are
        # slower but noticeably better, worth it if you have the
        # CPU (or a GPU - change device="cuda") to spare.
        _whisper_model = WhisperModel(
            "base",
            device="cpu",
            compute_type="int8"
        )

    return _whisper_model


def _normalize_word(word):
    return re.sub(r"[^a-z0-9']", "", word.lower())


def _record_loopback(duration_seconds, should_continue, samplerate=16000):
    """
    Records system audio output (whatever's playing through your
    speakers) in 1-second chunks, checking `should_continue` between
    each chunk so it can stop early if the track changes underneath
    it. Returns None if nothing was captured.
    """

    speaker = sc.default_speaker()

    mic = sc.get_microphone(
        id=str(speaker.name),
        include_loopback=True
    )

    chunks = []
    elapsed = 0.0
    chunk_seconds = 1.0

    # A little headroom past the reported duration, and a hard
    # ceiling so a bad duration value can't record forever.
    max_seconds = min(duration_seconds + 3, 15 * 60)

    with mic.recorder(samplerate=samplerate, channels=1) as recorder:
        while elapsed < max_seconds:
            if not should_continue():
                break

            data = recorder.record(
                numframes=int(chunk_seconds * samplerate)
            )

            chunks.append(data.flatten())
            elapsed += chunk_seconds

    if not chunks:
        return None

    return np.concatenate(chunks)


def _parse_reference_lines(synced_lyrics):
    lines = []

    for raw_line in synced_lyrics.split("\n"):
        match = re.match(
            r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$",
            raw_line
        )

        if not match:
            continue

        text = match.group(3).strip()

        if text:
            lines.append({"text": text})

    return lines


def _align_words_to_lyrics(whisper_words, reference_lines):
    """
    Maps the model's own transcribed words (which may contain
    mistakes - singing is hard to transcribe) onto the *correct*
    reference lyrics text from lrclib, transferring timestamps
    wherever a confident word match is found nearby, and
    interpolating the rest so there are never gaps.
    """

    whisper_tokens = [
        _normalize_word(w["word"])
        for w in whisper_words
    ]

    result = []
    search_from = 0

    for line in reference_lines:
        for word in line["text"].split():
            token = _normalize_word(word)

            match_index = None

            # Search forward only, within a reasonably sized
            # window - lyrics play in order, so this keeps
            # matching fast and avoids latching onto an earlier
            # occurrence of a repeated word (e.g. "the", "I").
            window_end = min(
                len(whisper_tokens),
                search_from + 40
            )

            for i in range(search_from, window_end):
                if token and whisper_tokens[i] == token:
                    match_index = i
                    break

            if match_index is not None:
                matched = whisper_words[match_index]

                result.append({
                    "word": word,
                    "start": matched["start"],
                    "end": matched["end"]
                })

                search_from = match_index + 1
            else:
                result.append({
                    "word": word,
                    "start": None,
                    "end": None
                })

    # Fill in unmatched words by interpolating between the
    # nearest matched neighbors, so playback never has a gap
    # with no timing at all.
    for i, item in enumerate(result):
        if item["start"] is not None:
            continue

        prev_end = next(
            (
                result[j]["end"]
                for j in range(i - 1, -1, -1)
                if result[j]["end"] is not None
            ),
            None
        )

        next_start = next(
            (
                result[j]["start"]
                for j in range(i + 1, len(result))
                if result[j]["start"] is not None
            ),
            None
        )

        if (
            prev_end is not None
            and next_start is not None
            and next_start > prev_end
        ):
            item["start"] = prev_end
            item["end"] = prev_end + (next_start - prev_end) * 0.5
        elif prev_end is not None:
            item["start"] = prev_end
            item["end"] = prev_end + 0.3
        elif next_start is not None:
            item["start"] = max(0, next_start - 0.3)
            item["end"] = next_start
        else:
            item["start"] = 0
            item["end"] = 0.3

    return result


def _run_alignment(artist, title, duration, synced_lyrics):
    key = (artist, title)

    try:
        reference_lines = _parse_reference_lines(synced_lyrics)

        if not reference_lines:
            return

        print(f"[word-sync] recording: {artist} - {title}")

        audio = _record_loopback(
            duration,
            should_continue=lambda: _now_playing_key == key
        )

        if audio is None or len(audio) < 16000:
            print("[word-sync] recording too short, skipping")
            return

        print(f"[word-sync] transcribing: {artist} - {title}")

        model = _get_whisper_model()

        segments, _ = model.transcribe(
            audio,
            word_timestamps=True
        )

        whisper_words = []

        for segment in segments:
            for w in (segment.words or []):
                whisper_words.append({
                    "word": w.word,
                    "start": w.start,
                    "end": w.end
                })

        if not whisper_words:
            print("[word-sync] transcription produced no words")
            return

        aligned = _align_words_to_lyrics(
            whisper_words,
            reference_lines
        )

        _save_cached_words(artist, title, aligned)

        print(
            f"[word-sync] done: {artist} - {title} "
            f"({len(aligned)} words)"
        )

    except Exception as e:
        print("[word-sync] failed, falling back silently:", repr(e))

    finally:
        _alignment_in_progress.discard(key)


def maybe_start_alignment(artist, title, position, duration, synced_lyrics):
    if not WORD_SYNC_ENABLED:
        return

    if not artist or not title or not duration or not synced_lyrics:
        return

    # Only attempt this near the start of a track, so the recording
    # actually captures the song from (close to) the beginning. If
    # we missed that window this time, it'll get another chance the
    # next time this track starts playing from the top.
    if position > 2.0:
        return

    key = (artist, title)

    if key in _alignment_in_progress:
        return

    if _load_cached_words(artist, title) is not None:
        return

    _alignment_in_progress.add(key)

    thread = threading.Thread(
        target=_run_alignment,
        args=(artist, title, duration, synced_lyrics),
        daemon=True
    )
    thread.start()



def get_lyrics(artist, title):

    try:
        response = requests.get(
            "https://lrclib.net/api/get",
            params={
                "artist_name": artist,
                "track_name": title
            },
            timeout=5
        )

        if response.status_code != 200:
            return {
                "lyrics": None,
                "syncedLyrics": None
            }

        data = response.json()

        return {
            "lyrics": data.get("plainLyrics"),
            "syncedLyrics": data.get("syncedLyrics")
        }

    except Exception as e:

        print("Lyrics error:", repr(e))

        return {
            "lyrics": None,
            "syncedLyrics": None
        }


async def get_session():

    manager = await (
        GlobalSystemMediaTransportControlsSessionManager
        .request_async()
    )

    return manager.get_current_session()


async def encode_artwork(thumbnail):

    stream = await thumbnail.open_read_async()

    input_stream = stream.get_input_stream_at(0)

    from winrt.windows.storage.streams import DataReader

    reader = DataReader(input_stream)

    size = stream.size

    artwork = None

    if size > 0:

        loaded = await reader.load_async(size)

        data = bytearray(loaded)

        reader.read_bytes(data)

        artwork = (
            "data:image/jpeg;base64,"
            + base64.b64encode(data).decode("utf-8")
        )

    reader.close()
    input_stream.close()
    stream.close()

    return artwork


async def get_current_song():

    session = await get_session()

    if session is None:
        return {
            "playing": False,
            "title": "",
            "artist": "",
            "album": "",
            "artwork": None,
            "position": 0,
            "duration": 0,
            "sampledAt": time.time()
        }

    properties = await session.try_get_media_properties_async()

    playback = session.get_playback_info()
    timeline = session.get_timeline_properties()

    is_playing = (
        playback.playback_status
        == GlobalSystemMediaTransportControlsSessionPlaybackStatus.PLAYING
    )

    position = timeline.position.total_seconds()

    # Capture the wall-clock time right now, as close as possible to
    # when we actually sampled the position above. Everything after
    # this point (artwork encoding, lyrics lookup, network transfer)
    # can take variable amounts of time, so the frontend uses this
    # timestamp to correct for that instead of assuming the position
    # is accurate at the moment the response arrives.
    sampled_at = time.time()

    title = properties.title
    artist = properties.artist
    album = properties.album_title

    track_key = (artist, title)

    # Let the background alignment thread (if one is running) know
    # what's currently playing, so it can stop early if the track
    # changes out from under it instead of recording the wrong song.
    global _now_playing_key
    _now_playing_key = track_key

    # Only redo the expensive work (artwork decode, lyrics fetch) when
    # the track has actually changed, instead of every single poll.
    if track_key != _track_cache["key"]:

        artwork = None

        if properties.thumbnail:
            artwork = await encode_artwork(properties.thumbnail)

        if artist and title:
            lyrics = get_lyrics(artist, title)
        else:
            lyrics = {"lyrics": None, "syncedLyrics": None}

        _track_cache["key"] = track_key
        _track_cache["artwork"] = artwork
        _track_cache["lyrics"] = lyrics["lyrics"]
        _track_cache["syncedLyrics"] = lyrics["syncedLyrics"]

    # Word-level timing, if we already have it cached for this track.
    # If we don't, kick off a background attempt to get it (this never
    # blocks the response - see maybe_start_alignment above for all
    # the ways this quietly no-ops instead of failing loudly).
    rich_words = None

    if WORD_SYNC_ENABLED and artist and title:
        rich_words = _load_cached_words(artist, title)

        if rich_words is None:
            maybe_start_alignment(
                artist,
                title,
                position,
                timeline.end_time.total_seconds(),
                _track_cache["syncedLyrics"]
            )

    return {
        "playing": is_playing,
        "title": title,
        "artist": artist,
        "album": album,
        "artwork": _track_cache["artwork"],
        "lyrics": _track_cache["lyrics"],
        "syncedLyrics": _track_cache["syncedLyrics"],
        "richWords": rich_words,

        "position": position,
        "duration": timeline.end_time.total_seconds(),
        "sampledAt": sampled_at
    }


async def change_position(position_seconds):

    session = await get_session()

    if session is None:
        return False

    # Windows media APIs use 100-nanosecond ticks.
    ticks = int(max(0, position_seconds) * 10_000_000)

    try:
        return await session.try_change_playback_position_async(ticks)
    except Exception as e:
        print("Change position error:", repr(e))
        return False


@app.route("/api/seek", methods=["POST"])
def seek():
    try:
        data = request.get_json()

        position = float(data.get("position", 0))

        asyncio.run(change_position(position))

        return {
            "success": True,
            "position": position
        }

    except Exception as e:
        print("Seek error:", e)

        return {
            "success": False,
            "error": str(e)
        }, 500

@app.route("/api/current")
def current():

    try:

        data = asyncio.run(get_current_song())

        return jsonify(data)

    except Exception as e:

        print("ERROR:", repr(e))

        return jsonify({
            "error": str(e)
        }), 500


# -------------------------
# PLAY / PAUSE
# -------------------------

@app.post("/api/play-pause")
def play_pause():

    async def toggle():

        session = await get_session()

        if session is None:
            return False

        result = await session.try_toggle_play_pause_async()

        return result

    try:

        result = asyncio.run(toggle())

        return jsonify({
            "success": result
        })

    except Exception as e:

        print("ERROR:", repr(e))

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

# -------------------------
# NEXT
# -------------------------

@app.post("/api/next")
def next_track():

    async def next_song():

        session = await get_session()

        if session is None:
            return False

        await session.try_skip_next_async()

        return True

    try:

        result = asyncio.run(next_song())

        return jsonify({
            "success": result
        })

    except Exception as e:

        print("ERROR:", repr(e))

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# -------------------------
# PREVIOUS
# -------------------------

@app.post("/api/previous")
def previous_track():

    async def previous_song():

        session = await get_session()

        if session is None:
            return False

        await session.try_skip_previous_async()

        return True

    try:

        result = asyncio.run(previous_song())

        return jsonify({
            "success": result
        })

    except Exception as e:

        print("ERROR:", repr(e))

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


if __name__ == "__main__":

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )
import asyncio
import base64
import datetime
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

    # -------------------------
    # Correct for staleness in Windows' own timeline snapshot.
    #
    # GlobalSystemMediaTransportControlsSessionTimelineProperties.position
    # is only a snapshot as of `last_updated_time` - Spotify doesn't push
    # position updates every frame, only occasionally. If we don't account
    # for how long ago that snapshot was taken, our reported position is
    # always a little behind reality.
    # -------------------------
    try:
        last_updated = timeline.last_updated_time

        if last_updated is not None and is_playing:

            now_utc = datetime.datetime.now(datetime.timezone.utc)

            elapsed = (now_utc - last_updated).total_seconds()

            # Sanity clamp - if this looks bogus (clock skew, bad
            # value, huge gap), ignore it rather than risk a wild jump.
            if 0 <= elapsed <= 15:
                position += elapsed

    except Exception:
        pass

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

    return {
        "playing": is_playing,
        "title": title,
        "artist": artist,
        "album": album,
        "artwork": _track_cache["artwork"],
        "lyrics": _track_cache["lyrics"],
        "syncedLyrics": _track_cache["syncedLyrics"],

        "position": position,
        "duration": timeline.end_time.total_seconds(),
        "sampledAt": sampled_at
    }


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
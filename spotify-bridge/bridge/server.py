import asyncio
import base64
import requests

from flask import Flask, jsonify
from flask_cors import CORS

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus
)

app = Flask(__name__)
CORS(app)

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


async def get_current_song():

    session = await get_session()

    if session is None:
        return {
            "playing": False,
            "title": "",
            "artist": "",
            "album": "",
            "artwork": None
        }

    properties = await session.try_get_media_properties_async()

    playback = session.get_playback_info()
    timeline = session.get_timeline_properties()

    artwork = None

    if properties.thumbnail:

        stream = await properties.thumbnail.open_read_async()

        input_stream = stream.get_input_stream_at(0)

        from winrt.windows.storage.streams import DataReader

        reader = DataReader(input_stream)

        size = stream.size

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

    return {
        "playing": (
            playback.playback_status
            == GlobalSystemMediaTransportControlsSessionPlaybackStatus.PLAYING
        ),
        "title": properties.title,
        "artist": properties.artist,
        "album": properties.album_title,
        "artwork": artwork,

        "position": timeline.position.total_seconds(),
        "duration": timeline.end_time.total_seconds()
    }


@app.route("/api/current")
def current():

    try:

        data = asyncio.run(get_current_song())

        if data["title"] and data["artist"]:

            lyrics = get_lyrics(
                data["artist"],
                data["title"]
            )

            data["lyrics"] = lyrics["lyrics"]
            data["syncedLyrics"] = lyrics["syncedLyrics"]

        else:

            data["lyrics"] = None
            data["syncedLyrics"] = None

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
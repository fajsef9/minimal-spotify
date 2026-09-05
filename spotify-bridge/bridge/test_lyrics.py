import requests

ARTIST = "Don Toliver"
TITLE = "TORE UP"
ALBUM = "HARDSTONE PSYCHO"
DURATION = 126.986

BASE_URL = "https://synclrc.dev"


def search_track():
    print("=" * 60)
    print("SYNC LRC SEARCH")
    print("=" * 60)

    response = requests.get(
        f"{BASE_URL}/search",
        params={
            "q": f"{TITLE} {ARTIST}",
            "limit": 10
        },
        timeout=15
    )

    print("Status:", response.status_code)

    response.raise_for_status()

    data = response.json()

    results = data.get("results", [])

    print(f"Found {len(results)} result(s)\n")

    for i, result in enumerate(results):
        print(f"[{i}]")
        print("ID:", result.get("id"))
        print("Track:", result.get("track"))
        print("Artist:", result.get("artist"))
        print("Album:", result.get("album"))
        print()

    return results


def get_karaoke(track_id):
    print("=" * 60)
    print("GETTING KARAOKE LYRICS")
    print("=" * 60)

    response = requests.get(
        f"{BASE_URL}/lyrics/{track_id}",
        params={
            "type": "karaoke"
        },
        timeout=15
    )

    print("Status:", response.status_code)

    response.raise_for_status()

    data = response.json()

    karaoke = data.get("karaoke")

    if not karaoke:
        print("NO KARAOKE LYRICS FOUND")
        return

    print("\nWORD-SYNCED LYRICS:\n")
    print(karaoke)

    # Check for word timestamps
    if "<00:" in karaoke or "<01:" in karaoke:
        print("\nWORD TIMING FOUND!")
    else:
        print("\nOnly line timing found.")


def main():
    results = search_track()

    if not results:
        print("SyncLRC has no result for this song.")
        return

    # Prefer exact match
    selected = None

    for result in results:
        track = result.get("track", "").lower()
        artist = result.get("artist", "").lower()

        if (
            track == TITLE.lower()
            and artist == ARTIST.lower()
        ):
            selected = result
            break

    if selected is None:
        selected = results[0]

    print("Using:")
    print(selected.get("track"))
    print(selected.get("artist"))
    print("ID:", selected.get("id"))
    print()

    get_karaoke(selected.get("id"))


if __name__ == "__main__":
    main()
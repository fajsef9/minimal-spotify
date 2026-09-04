import asyncio

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager
)


async def main():

    manager = await (
        GlobalSystemMediaTransportControlsSessionManager
        .request_async()
    )

    session = manager.get_current_session()

    if session is None:
        print("No media session found.")
        return

    properties = await session.try_get_media_properties_async()

    print()
    print("Currently playing:")
    print("------------------")
    print("Title :", properties.title)
    print("Artist:", properties.artist)
    print("Album :", properties.album_title)


asyncio.run(main())
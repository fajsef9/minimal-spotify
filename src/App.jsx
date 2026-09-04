import { useEffect, useRef, useState } from "react";
import "./App.css";

function App() {
  const [song, setSong] = useState(null);
  const [displayPosition, setDisplayPosition] = useState(0);
  const [currentLyric, setCurrentLyric] = useState(0);

  // Local playback clock
  const clockRef = useRef({
    position: 0,
    timestamp: performance.now(),
    playing: false,
  });

  const lyricRefs = useRef([]);

  /*
   * Get current Spotify state
   */
  const getSong = async () => {
    try {
      const response = await fetch(
        "http://localhost:5000/api/current"
      );

      const data = await response.json();

      if (data.error) {
        console.error(data.error);
        return;
      }

      setSong(data);

      const now = performance.now();

      const local = clockRef.current;

      /*
       * Position reported by Windows/Spotify
       */
      const spotifyPosition =
        typeof data.position === "number"
          ? data.position
          : 0;

      /*
       * What our local clock currently thinks
       * the position should be.
       */
      let estimatedPosition = local.position;

      if (local.playing) {
        estimatedPosition +=
          (now - local.timestamp) / 1000;
      }

      /*
       * Difference between Spotify and our clock.
       */
      const difference =
        spotifyPosition - estimatedPosition;

      /*
       * If the difference is tiny, don't jump.
       *
       * This prevents:
       *
       * 42.9
       * 43.0
       * 42.8
       *
       * from causing visible movement backwards.
       */
      if (Math.abs(difference) < 0.5) {
        // Keep our local clock.
        // Small error will naturally be corrected later.
        local.position = estimatedPosition;
      } else {
        /*
         * If there's a significant difference,
         * Spotify probably skipped, seeked, paused,
         * or something else changed.
         *
         * Snap to Spotify.
         */
        local.position = spotifyPosition;
      }

      local.timestamp = now;
      local.playing = data.playing;

      setDisplayPosition(local.position);

    } catch (error) {
      console.error(
        "Could not connect to Spotify bridge:",
        error
      );
    }
  };


  /*
   * Poll Spotify once per second.
   *
   * This is synchronization only.
   * It is NOT responsible for animation.
   */
  useEffect(() => {
    getSong();

    const interval = setInterval(
      getSong,
      1000
    );

    return () => {
      clearInterval(interval);
    };
  }, []);


  /*
   * Smooth local playback clock.
   *
   * This runs every animation frame instead of
   * waiting for the API.
   */
  useEffect(() => {
    let animationFrame;

    const animate = (timestamp) => {
      const clock = clockRef.current;

      let position = clock.position;

      if (clock.playing) {
        position =
          clock.position +
          (timestamp - clock.timestamp) / 1000;
      }

      /*
       * Prevent going beyond duration.
       */
      if (
        song?.duration &&
        position > song.duration
      ) {
        position = song.duration;
      }

      setDisplayPosition(position);

      animationFrame =
        requestAnimationFrame(animate);
    };

    animationFrame =
      requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
    };
  }, [song]);


  /*
   * Format seconds → M:SS
   */
  const formatTime = (seconds) => {
    if (
      seconds === undefined ||
      seconds === null ||
      isNaN(seconds)
    ) {
      return "0:00";
    }

    const minutes =
      Math.floor(seconds / 60);

    const remainingSeconds =
      Math.floor(seconds % 60);

    return `${minutes}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  };


  /*
   * Parse synced lyrics
   */
  const parseLyrics = (lyrics) => {
    if (!lyrics) {
      return [];
    }

    return lyrics
      .split("\n")
      .map((line) => {

        const match =
          line.match(
            /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/
          );

        if (!match) {
          return null;
        }

        const minutes =
          parseInt(match[1]);

        const seconds =
          parseFloat(match[2]);

        return {
          time:
            minutes * 60 + seconds,

          text:
            match[3].trim(),
        };
      })
      .filter(Boolean);
  };


  /*
   * Parse current song's lyrics
   */
  const parsedLyrics =
    parseLyrics(song?.syncedLyrics);


  /*
   * Determine which lyric is currently playing
   */
  useEffect(() => {

    if (
      parsedLyrics.length === 0
    ) {
      return;
    }

    let activeIndex = 0;

    for (
      let i = 0;
      i < parsedLyrics.length;
      i++
    ) {

      if (
        displayPosition >=
        parsedLyrics[i].time
      ) {
        activeIndex = i;
      } else {
        break;
      }
    }

    setCurrentLyric(activeIndex);

  }, [
    displayPosition,
    song?.syncedLyrics
  ]);


  /*
   * Scroll active lyric into view
   */
  useEffect(() => {

    const element =
      lyricRefs.current[currentLyric];

    if (element) {

      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });

    }

  }, [currentLyric]);


  /*
   * Previous track
   */
  const previousTrack = async () => {

    try {

      await fetch(
        "http://localhost:5000/api/previous",
        {
          method: "POST",
        }
      );

      setTimeout(
        getSong,
        300
      );

    } catch (error) {

      console.error(
        "Could not skip to previous track:",
        error
      );

    }
  };


  /*
   * Play / pause
   */
  const togglePlayPause = async () => {

    try {

      await fetch(
        "http://localhost:5000/api/play-pause",
        {
          method: "POST",
        }
      );

      /*
       * Get the real Spotify state shortly
       * after the button press.
       */
      setTimeout(
        getSong,
        200
      );

    } catch (error) {

      console.error(
        "Could not toggle playback:",
        error
      );

    }
  };


  /*
   * Next track
   */
  const nextTrack = async () => {

    try {

      await fetch(
        "http://localhost:5000/api/next",
        {
          method: "POST",
        }
      );

      setTimeout(
        getSong,
        300
      );

    } catch (error) {

      console.error(
        "Could not skip to next track:",
        error
      );

    }
  };


  /*
   * No song
   */
  if (!song) {

    return (
      <div className="app">
        <p>
          Connecting to Spotify...
        </p>
      </div>
    );
  }


  /*
   * Progress percentage
   */
  const progress =
    song.duration
      ? Math.min(
          (displayPosition /
            song.duration) *
            100,
          100
        )
      : 0;


  return (
    <main className="app">

      {/* =====================
          PLAYER
      ===================== */}

      <div className="player">

        {/* Album artwork */}

        {song.artwork ? (

          <img
            className="album-cover"
            src={song.artwork}
            alt={song.album}
          />

        ) : (

          <div className="album-placeholder">
            No artwork
          </div>

        )}


        {/* Song information */}

        <div className="song-info">

          <h1>
            {song.title ||
              "Nothing playing"}
          </h1>

          <p>
            {song.artist}
          </p>

        </div>


        {/* Controls */}

        <div className="controls">

          <button
            onClick={previousTrack}
            aria-label="Previous track"
          >
            ←
          </button>

          <button
            onClick={togglePlayPause}
            aria-label={
              song.playing
                ? "Pause"
                : "Play"
            }
          >
            {song.playing
              ? "Ⅱ"
              : "▶"}
          </button>

          <button
            onClick={nextTrack}
            aria-label="Next track"
          >
            →
          </button>

        </div>


        {/* Progress */}

        <div className="progress-container">

          <div className="progress-bar">

            <div
              className="progress"
              style={{
                width:
                  `${progress}%`,
              }}
            />

          </div>

          <div className="time">

            <span>
              {formatTime(
                displayPosition
              )}
            </span>

            <span>
              {formatTime(
                song.duration
              )}
            </span>

          </div>

        </div>

      </div>


      {/* =====================
          LYRICS
      ===================== */}

      <section className="lyrics">

        <h2>
          Lyrics
        </h2>

        {parsedLyrics.length > 0 ? (

          <div className="lyrics-text">

            {parsedLyrics.map(
              (line, index) => (

                <p
                  key={index}
                  ref={(element) => {
                    lyricRefs.current[index] =
                      element;
                  }}
                  className={
                    index === currentLyric
                      ? "active-lyric"
                      : ""
                  }
                >
                  {line.text ||
                    "\u00A0"}
                </p>

              )
            )}

          </div>

        ) : song.lyrics ? (

          <div className="lyrics-text">

            {song.lyrics
              .split("\n")
              .map(
                (line, index) => (

                  <p key={index}>
                    {line ||
                      "\u00A0"}
                  </p>

                )
              )}

          </div>

        ) : (

          <p className="no-lyrics">
            Lyrics not available
          </p>

        )}

      </section>

    </main>
  );
}

export default App;
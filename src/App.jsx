import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const BRIDGE_URL = "http://localhost:5000";

function App() {
  const [song, setSong] = useState(null);
  const [displayPosition, setDisplayPosition] = useState(0);
  const [currentWord, setCurrentWord] = useState(0);

  const clockRef = useRef({
    position: 0,
    timestamp: performance.now(),
    playing: false,
  });

  const songRef = useRef(null);

  useEffect(() => {
    songRef.current = song;
  }, [song]);

  // ==========================================
  // GET CURRENT SONG FROM SPOTIFY BRIDGE
  // ==========================================

  const getSong = async () => {
    try {
      const response = await fetch(
        `${BRIDGE_URL}/api/current`
      );

      if (!response.ok) {
        throw new Error(
          `Bridge returned ${response.status}`
        );
      }

      const data = await response.json();

      if (data.error) {
        console.error(data.error);
        return;
      }

      setSong(data);

      const now = performance.now();

      const spotifyPosition =
        typeof data.position === "number"
          ? data.position
          : 0;

      const clock = clockRef.current;

      let estimatedPosition = clock.position;

      if (clock.playing) {
        estimatedPosition +=
          (now - clock.timestamp) / 1000;
      }

      const difference =
        spotifyPosition - estimatedPosition;

      /*
       * Spotify's reported position can move
       * slightly backwards/forwards.
       *
       * Only correct the local clock when the
       * difference is significant.
       */
      if (Math.abs(difference) > 0.5) {
        clock.position = spotifyPosition;
      } else {
        clock.position = estimatedPosition;
      }

      clock.timestamp = now;
      clock.playing = Boolean(data.playing);

      setDisplayPosition(clock.position);
    } catch (error) {
      console.error(
        "Could not connect to Spotify bridge:",
        error
      );
    }
  };

  // ==========================================
  // POLL SPOTIFY EVERY SECOND
  // ==========================================

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

  // ==========================================
  // SMOOTH LOCAL PLAYBACK CLOCK
  // ==========================================

  useEffect(() => {
    let animationFrame;

    const animate = (timestamp) => {
      const clock = clockRef.current;
      const currentSong = songRef.current;

      let position = clock.position;

      if (clock.playing) {
        position =
          clock.position +
          (timestamp - clock.timestamp) / 1000;
      }

      if (
        currentSong?.duration &&
        position > currentSong.duration
      ) {
        position = currentSong.duration;
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
  }, []);

  // ==========================================
  // PARSE LRC LYRICS
  // ==========================================

  const parsedLines = useMemo(() => {
    if (!song?.syncedLyrics) {
      return [];
    }

    return song.syncedLyrics
      .split("\n")
      .map((line) => {
        const match = line.match(
          /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/
        );

        if (!match) {
          return null;
        }

        const minutes =
          parseInt(match[1], 10);

        const seconds =
          parseFloat(match[2]);

        return {
          time:
            minutes * 60 +
            seconds,

          text: match[3].trim(),
        };
      })
      .filter(Boolean);
  }, [song?.syncedLyrics]);

  // ==========================================
  // TURN LINES INTO WORDS
  // ==========================================

  const words = useMemo(() => {
    if (!parsedLines.length) {
      return [];
    }

    const result = [];

    parsedLines.forEach(
      (line, lineIndex) => {
        if (!line.text) {
          return;
        }

        const lineWords =
          line.text
            .split(/\s+/)
            .filter(Boolean);

        const nextLine =
          parsedLines[lineIndex + 1];

        let lineEnd;

        if (nextLine) {
          lineEnd = nextLine.time;
        } else if (song?.duration) {
          lineEnd = song.duration;
        } else {
          lineEnd =
            line.time +
            Math.max(
              lineWords.length * 0.4,
              2
            );
        }

        const lineDuration =
          Math.max(
            lineEnd - line.time,
            0.1
          );

        const wordDuration =
          lineDuration /
          lineWords.length;

        lineWords.forEach(
          (word, wordIndex) => {
            const start =
              line.time +
              wordIndex *
                wordDuration;

            const end =
              line.time +
              (wordIndex + 1) *
                wordDuration;

            result.push({
              text: word,
              start,
              end,
              lineIndex,
            });
          }
        );
      }
    );

    return result;
  }, [
    parsedLines,
    song?.duration,
  ]);

  // ==========================================
  // FIND CURRENT WORD
  // ==========================================

  useEffect(() => {
    if (!words.length) {
      return;
    }

    let index = 0;

    for (
      let i = 0;
      i < words.length;
      i++
    ) {
      if (
        displayPosition >=
        words[i].start
      ) {
        index = i;
      } else {
        break;
      }
    }

    setCurrentWord(index);
  }, [
    displayPosition,
    words,
  ]);

  // ==========================================
  // PLAY / PAUSE
  // ==========================================

  const togglePlayPause =
    async () => {
      try {
        await fetch(
          `${BRIDGE_URL}/api/play-pause`,
          {
            method: "POST",
          }
        );

        setTimeout(
          getSong,
          150
        );
      } catch (error) {
        console.error(
          "Play/pause failed:",
          error
        );
      }
    };

  // ==========================================
  // SEEK
  // ==========================================

  const seek = async (amount) => {
    if (!song) {
      return;
    }

    const current =
      clockRef.current.position;

    const duration =
      song.duration || Infinity;

    const newPosition =
      Math.max(
        0,
        Math.min(
          current + amount,
          duration
        )
      );

    // Update UI immediately
    clockRef.current.position =
      newPosition;

    clockRef.current.timestamp =
      performance.now();

    setDisplayPosition(
      newPosition
    );

    try {
      await fetch(
        `${BRIDGE_URL}/api/seek`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            position:
              newPosition,
          }),
        }
      );

      setTimeout(
        getSong,
        150
      );
    } catch (error) {
      console.error(
        "Seek failed:",
        error
      );
    }
  };

  // ==========================================
  // TIME FORMAT
  // ==========================================

  const formatTime = (
    seconds
  ) => {
    if (
      seconds === undefined ||
      seconds === null ||
      isNaN(seconds)
    ) {
      return "0:00";
    }

    const minutes =
      Math.floor(
        seconds / 60
      );

    const remainingSeconds =
      Math.floor(
        seconds % 60
      );

    return `${minutes}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  };

  // ==========================================
  // PROGRESS
  // ==========================================

  const progress =
    song?.duration
      ? Math.min(
          (displayPosition /
            song.duration) *
            100,
          100
        )
      : 0;

  // ==========================================
  // ONLY SHOW:
  //
  // 4 PREVIOUS
  // CURRENT
  // 2 NEXT
  // ==========================================

  const visibleWords = [];

  if (words.length) {
    const start =
      Math.max(
        0,
        currentWord - 4
      );

    const end =
      Math.min(
        words.length,
        currentWord + 3
      );

    for (
      let i = start;
      i < end;
      i++
    ) {
      visibleWords.push({
        ...words[i],
        index: i,
      });
    }
  }

  // ==========================================
  // LOADING
  // ==========================================

  if (!song) {
    return (
      <div className="loading-screen">
        Connecting to Spotify...
      </div>
    );
  }

  // ==========================================
  // UI
  // ==========================================

  return (
    <main className="app">

      {/* =====================================
          HEADER
      ====================================== */}

      <header className="top-bar">
        <div className="brand">
          MINIMAL SPOTIFY
        </div>
      </header>


      {/* =====================================
          LEFT PLAYER
      ====================================== */}

      <section className="player-panel">

        {/* ALBUM */}

        <div className="album-wrapper">

          {song.artwork ? (
            <img
              className="album-cover"
              src={song.artwork}
              alt={
                song.album ||
                "Album artwork"
              }
            />
          ) : (
            <div className="album-placeholder">
              No artwork
            </div>
          )}

        </div>


        {/* SONG INFORMATION */}

        <div className="song-information">

          <h1>
            {song.title ||
              "Nothing playing"}
          </h1>

          <p>
            {song.artist ||
              "Unknown artist"}
          </p>

        </div>


        {/* PROGRESS */}

        <div className="progress-section">

          <div className="progress-bar">

            <div
              className="progress-fill"
              style={{
                width:
                  `${progress}%`,
              }}
            />

          </div>


          <div className="time-labels">

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


        {/* =================================
            CONTROLS
        ================================== */}

        <div className="controls">

          {/* -10 */}

          <button
            className="control-button seek-button"
            onClick={() =>
              seek(-10)
            }
            aria-label="Back 10 seconds"
          >

            <span className="seek-arrow">
              ↶
            </span>

            <span className="seek-number">
              10
            </span>

          </button>


          {/* PLAY / PAUSE */}

          <button
            className="control-button play-button"
            onClick={
              togglePlayPause
            }
            aria-label={
              song.playing
                ? "Pause"
                : "Play"
            }
          >

            {song.playing ? (
              <span className="pause-symbol">
                II
              </span>
            ) : (
              <span className="play-symbol">
                ▶
              </span>
            )}

          </button>


          {/* +10 */}

          <button
            className="control-button seek-button"
            onClick={() =>
              seek(10)
            }
            aria-label="Forward 10 seconds"
          >

            <span className="seek-number">
              10
            </span>

            <span className="seek-arrow forward">
              ↷
            </span>

          </button>

        </div>


        {/* LYRICS LABEL */}

        <div className="lyrics-label">

          <span className="lyrics-icon">
            ▰
          </span>

          <span>
            Lyrics
          </span>

        </div>

      </section>


      {/* =====================================
          RIGHT LYRICS
      ====================================== */}

      <section className="lyrics-panel">

        <div className="lyrics-top-line" />


        <div className="word-stage">

          {words.length ? (

            visibleWords.map(
              (word) => {

                const distance =
                  word.index -
                  currentWord;

                let className =
                  "lyric-word";

                if (
                  word.index ===
                  currentWord
                ) {
                  className +=
                    " current-word";
                } else if (
                  distance < 0
                ) {
                  className +=
                    " previous-word";
                } else {
                  className +=
                    " next-word";
                }

                return (
                  <div
                    key={`${word.index}-${word.text}`}
                    className={
                      className
                    }
                    style={{
                      "--word-y":
                        `${distance * 74}px`,
                    }}
                  >
                    {word.text}
                  </div>
                );
              }
            )

          ) : (

            <div className="no-lyrics">
              Lyrics not available
            </div>

          )}

        </div>


        {/* FOOTER */}

        <div className="lyrics-footer">

          <div className="waveform">

            {Array.from({
              length: 13,
            }).map(
              (_, i) => (
                <span
                  key={i}
                  style={{
                    "--i": i,
                  }}
                />
              )
            )}

          </div>

          <div className="footer-song">
            {song.title}
          </div>

        </div>


        <div className="lyrics-bottom-line" />

      </section>

    </main>
  );
}

export default App;
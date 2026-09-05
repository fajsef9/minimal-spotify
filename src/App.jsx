import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const BRIDGE_URL = "http://localhost:5000";

function App() {
  const [song, setSong] = useState(null);
  const [displayPosition, setDisplayPosition] = useState(0);
  const [currentWord, setCurrentWord] = useState(0);
  const [showLyrics, setShowLyrics] = useState(true);

  const clockRef = useRef({
    position: 0,
    timestamp: performance.now(),
    playing: false,
  });

  const songRef = useRef(null);

  useEffect(() => {
    songRef.current = song;
  }, [song]);

  // ============================================================
  // GET CURRENT SONG
  // ============================================================

  const getSong = async () => {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/current`);

      if (!response.ok) {
        throw new Error(`Bridge returned ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        console.error(data.error);
        return;
      }

      setSong(data);

      const now = performance.now();

      let spotifyPosition =
        typeof data.position === "number"
          ? data.position
          : 0;

      if (typeof data.sampledAt === "number") {
        const latency =
          Date.now() / 1000 - data.sampledAt;

        if (
          data.playing &&
          latency > 0 &&
          latency < 5
        ) {
          spotifyPosition += latency;
        }
      }

      const clock = clockRef.current;

      let estimatedPosition = clock.position;

      if (clock.playing) {
        estimatedPosition +=
          (now - clock.timestamp) / 1000;
      }

      const difference =
        spotifyPosition - estimatedPosition;

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

  // ============================================================
  // POLL SPOTIFY
  // ============================================================

  useEffect(() => {
    getSong();

    const interval = setInterval(getSong, 1000);

    return () => clearInterval(interval);
  }, []);

  // ============================================================
  // LOCAL CLOCK
  // ============================================================

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

  // ============================================================
  // PARSE LRC
  // ============================================================

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

        const minutes = parseInt(match[1], 10);
        const seconds = parseFloat(match[2]);

        return {
          time:
            minutes * 60 +
            seconds,
          text: match[3].trim(),
        };
      })
      .filter(Boolean);
  }, [song?.syncedLyrics]);

  // ============================================================
  // SYLLABLE ESTIMATION
  // ============================================================

  const estimateSyllables = (word) => {
    const clean = word
      .toLowerCase()
      .replace(/[^a-z']/g, "");

    if (!clean) {
      return 1;
    }

    const vowelGroups =
      clean.match(/[aeiouy]+/g);

    let count = vowelGroups
      ? vowelGroups.length
      : 1;

    if (
      clean.endsWith("e") &&
      !clean.endsWith("le") &&
      count > 1
    ) {
      count--;
    }

    return Math.max(1, count);
  };

  // ============================================================
  // CREATE WORD TIMINGS
  // ============================================================

  const estimatedWords = useMemo(() => {
    if (!parsedLines.length) {
      return [];
    }

    const result = [];

    parsedLines.forEach((line, lineIndex) => {
      if (!line.text) {
        return;
      }

      const lineWords = line.text
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

      const weights =
        lineWords.map((word) => {
          const syllables =
            estimateSyllables(word);

          const punctuation =
            /[,.!?;:]$/.test(word);

          return (
            syllables +
            (punctuation ? 0.35 : 0)
          );
        });

      const totalWeight =
        weights.reduce(
          (sum, value) =>
            sum + value,
          0
        ) || 1;

      let cursor = line.time;

      lineWords.forEach(
        (word, wordIndex) => {
          const weight =
            weights[wordIndex];

          const duration =
            Math.max(
              lineDuration *
                (weight /
                  totalWeight),
              0.12
            );

          const start = cursor;
          const end =
            start + duration;

          cursor = end;

          result.push({
            text: word,
            start,
            end,
            lineIndex,
          });
        }
      );
    });

    return result;
  }, [
    parsedLines,
    song?.duration,
  ]);

  // ============================================================
  // WORD DATA
  // ============================================================

  const words = useMemo(() => {
    if (
      Array.isArray(song?.richWords) &&
      song.richWords.length
    ) {
      return song.richWords.map(
        (word, index) => ({
          text: word.word,
          start: word.start,
          end: word.end,
          index,
        })
      );
    }

    return estimatedWords.map(
      (word, index) => ({
        ...word,
        index,
      })
    );
  }, [
    song?.richWords,
    estimatedWords,
  ]);

  // ============================================================
  // ACTIVE WORD
  // ============================================================

  useEffect(() => {
    if (!words.length) {
      return;
    }

    let activeIndex = 0;

    for (let i = 0; i < words.length; i++) {
      if (
        displayPosition >=
        words[i].start
      ) {
        activeIndex = i;
      } else {
        break;
      }
    }

    setCurrentWord(activeIndex);
  }, [
    displayPosition,
    words,
  ]);

  // ============================================================
  // CONTROLS
  // ============================================================

  const togglePlayPause = async () => {
    try {
      await fetch(
        `${BRIDGE_URL}/api/play-pause`,
        {
          method: "POST",
        }
      );

      setTimeout(getSong, 150);
    } catch (error) {
      console.error(
        "Play/pause failed:",
        error
      );
    }
  };

  const resetClock = () => {
    clockRef.current = {
      position: 0,
      timestamp:
        performance.now(),
      playing: false,
    };

    setDisplayPosition(0);
    setCurrentWord(0);
  };

  const previousTrack = async () => {
    resetClock();

    try {
      await fetch(
        `${BRIDGE_URL}/api/previous`,
        {
          method: "POST",
        }
      );

      setTimeout(getSong, 300);
    } catch (error) {
      console.error(
        "Previous track failed:",
        error
      );
    }
  };

  const nextTrack = async () => {
    resetClock();

    try {
      await fetch(
        `${BRIDGE_URL}/api/next`,
        {
          method: "POST",
        }
      );

      setTimeout(getSong, 300);
    } catch (error) {
      console.error(
        "Next track failed:",
        error
      );
    }
  };

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

    clockRef.current.position =
      newPosition;

    clockRef.current.timestamp =
      performance.now();

    setDisplayPosition(newPosition);

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

      setTimeout(getSong, 150);
    } catch (error) {
      console.error(
        "Seek failed:",
        error
      );
    }
  };

  // ============================================================
  // FORMAT TIME
  // ============================================================

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

    const remaining =
      Math.floor(seconds % 60);

    return `${minutes}:${remaining
      .toString()
      .padStart(2, "0")}`;
  };

  // ============================================================
  // PROGRESS
  // ============================================================

  const progress =
    song?.duration
      ? Math.min(
          (displayPosition /
            song.duration) *
            100,
          100
        )
      : 0;

  // ============================================================
  // VISIBLE WORDS
  // ============================================================

  const visibleWords = useMemo(() => {
    if (!words.length) {
      return [];
    }

    const result = [];

    const start =
      Math.max(
        0,
        currentWord - 2
      );

    const end =
      Math.min(
        words.length,
        currentWord + 4
      );

    for (
      let i = start;
      i < end;
      i++
    ) {
      result.push(words[i]);
    }

    return result;
  }, [
    words,
    currentWord,
  ]);

  // ============================================================
  // RENDER
  // ============================================================

  if (!song) {
    return (
      <div className="loading-screen">
        Connecting to Spotify...
      </div>
    );
  }

  return (
    <main
      className={`app ${
        showLyrics
          ? ""
          : "app-no-lyrics"
      }`}
    >
      <header className="top-bar">
        <div className="brand">
          MINIMAL SPOTIFY
        </div>
      </header>

      {/* ======================================================
          PLAYER
      ======================================================= */}

      <section className="player-panel">

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

        <div className="controls">

          <button
            className="control-button track-button"
            onClick={
              previousTrack
            }
          >
            ⏮
          </button>

          <button
            className="control-button seek-button"
            onClick={() =>
              seek(-10)
            }
          >
            <span className="seek-arrow">
              ↶
            </span>

            <span className="seek-number">
              10
            </span>
          </button>

          <button
            className="control-button play-button"
            onClick={
              togglePlayPause
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

          <button
            className="control-button seek-button"
            onClick={() =>
              seek(10)
            }
          >
            <span className="seek-number">
              10
            </span>

            <span className="seek-arrow forward">
              ↷
            </span>
          </button>

          <button
            className="control-button track-button"
            onClick={
              nextTrack
            }
          >
            ⏭
          </button>

        </div>

        <button
          type="button"
          className={`lyrics-label ${
            showLyrics
              ? "active"
              : ""
          }`}
          onClick={() =>
            setShowLyrics(
              (value) =>
                !value
            )
          }
        >
          <span className="lyrics-icon">
            ▰
          </span>

          <span>
            Lyrics
          </span>
        </button>

      </section>

      {/* ======================================================
          LYRICS
      ======================================================= */}

      {showLyrics && (
        <section className="lyrics-panel">

          <div className="lyrics-top-line" />

          <div className="word-stage">

            {words.length ? (
              visibleWords.map(
                (word) => {

                  const distance =
                    word.index -
                    currentWord;

                  const isCurrent =
                    distance === 0;

                  const isPrevious =
                    distance < 0;

                  /*
                   * Alternate entrance direction.
                   *
                   * Even words:
                   * RIGHT -> CENTRE
                   *
                   * Odd words:
                   * LEFT -> CENTRE
                   */

                  const direction =
                    word.index % 2 === 0
                      ? "right"
                      : "left";

                  let className =
                    "lyric-word";

                  if (
                    isCurrent
                  ) {
                    className +=
                      " current-word";
                  } else if (
                    isPrevious
                  ) {
                    className +=
                      " previous-word";
                  } else {
                    className +=
                      " next-word";
                  }

                  return (
                    <div
                      key={
                        word.index
                      }
                      className={
                        className
                      }
                      data-direction={
                        direction
                      }
                      style={{
                        "--distance":
                          distance,
                      }}
                    >
                      <span className="word-inner">
                        {
                          word.text
                        }
                      </span>
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

          <div className="lyrics-footer">

            <div className="waveform">
              {Array.from({
                length: 13,
              }).map(
                (_, index) => (
                  <span
                    key={index}
                    style={{
                      "--i":
                        index,
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
      )}
    </main>
  );
}

export default App;
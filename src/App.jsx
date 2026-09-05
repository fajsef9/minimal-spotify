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

      let spotifyPosition =
        typeof data.position === "number"
          ? data.position
          : 0;

      /*
       * Correct for the time between the bridge sampling the
       * position (data.sampledAt, a wall-clock timestamp) and
       * us actually receiving the response here - network time
       * plus whatever the request took server-side. Without this,
       * the reported position is always a little stale, by however
       * long that round trip happened to take that particular poll.
       */
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
  // ESTIMATE SYLLABLES PER WORD
  //
  // LRC lyrics only give us a timestamp per line, not per
  // word, so word-level timing is always an estimate - lrclib
  // (the source this app uses) doesn't provide true word-by-word
  // sync. Splitting a line's duration by character count (the
  // previous approach) is a weak proxy - a word like "strengths"
  // is one syllable but nine characters, so it was getting way
  // more screen time than it's actually sung for. Syllable count
  // tracks spoken/sung duration much more closely.
  // ==========================================

  const estimateSyllables = (word) => {
    const clean = word
      .toLowerCase()
      .replace(/[^a-z']/g, "");

    if (!clean) {
      return 1;
    }

    const vowelGroups =
      clean.match(/[aeiouy]+/g);

    let count =
      vowelGroups ? vowelGroups.length : 1;

    // Silent trailing "e" (e.g. "like", "summer" -> "summe")
    if (
      clean.endsWith("e") &&
      !clean.endsWith("le") &&
      count > 1
    ) {
      count -= 1;
    }

    return Math.max(1, count);
  };

  // Generous ceiling on how long a single word is allowed to stay
  // highlighted, in seconds per estimated syllable. This is the
  // actual fix for most of the "words drift out of sync" cases:
  // the previous version always stretched a line's *last* word all
  // the way to the next line's timestamp, so if there was a musical
  // pause / breath gap between two lines (very common), that entire
  // silent gap got attributed to one word as if it were being sung
  // that whole time - throwing every word before it out of sync too,
  // since they all shared the same inflated line duration. Capping
  // each word's duration means gaps are now just left as silence
  // (nothing highlighted) instead of being stretched onto a word.
  const MAX_SECONDS_PER_SYLLABLE = 0.55;

  // ==========================================
  // TURN LINES INTO WORDS (SYLLABLE ESTIMATE)
  //
  // This is the fallback path - used whenever real word-level
  // timing (song.richWords, from the bridge's audio-alignment
  // step) isn't available for the current track yet.
  // ==========================================

  const estimatedWords = useMemo(() => {
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

        /*
         * Weight each word by estimated syllables, with a small
         * bonus for trailing punctuation (a comma/period usually
         * means a brief lingering pause before the next word).
         */
        const wordWeights =
          lineWords.map((word) => {
            const syllables =
              estimateSyllables(word);

            const hasPause =
              /[,.!?;:]$/.test(word);

            return (
              syllables +
              (hasPause ? 0.4 : 0)
            );
          });

        const totalWeight =
          wordWeights.reduce(
            (sum, w) => sum + w,
            0
          ) || 1;

        let cursor = line.time;

        lineWords.forEach(
          (word, wordIndex) => {
            const weight =
              wordWeights[wordIndex];

            const proportionalDuration =
              lineDuration *
              (weight / totalWeight);

            // Never let a single word's highlighted duration run
            // past what's plausible for its syllable count, even
            // if the line as a whole spans a long silent gap.
            const cappedDuration =
              Math.min(
                proportionalDuration,
                weight * MAX_SECONDS_PER_SYLLABLE
              );

            const duration =
              Math.max(
                cappedDuration,
                0.12
              );

            const start = cursor;
            const end = start + duration;

            cursor = end;

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
  // REAL WORD-LEVEL SYNC, WHEN AVAILABLE
  //
  // The bridge records the song's own audio in the background and
  // aligns it to the real lyrics text (see server.py) - this is
  // only present once that's finished for the current track. Until
  // then (or if it fails for any reason - missing packages, no mic
  // permission, alignment error), song.richWords is just absent and
  // we transparently keep using the syllable estimate above. Same
  // shape either way, so nothing downstream needs to know which one
  // it's looking at.
  // ==========================================

  const words = useMemo(() => {
    if (
      !Array.isArray(song?.richWords) ||
      song.richWords.length === 0
    ) {
      return estimatedWords;
    }

    return song.richWords.map((word, index) => ({
      text: word.word,
      start: word.start,
      end: word.end,
      lineIndex: index,
    }));
  }, [song?.richWords, estimatedWords]);

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
  // PREVIOUS / NEXT TRACK
  //
  // Unlike seek() below, these never reset the local clock -
  // they just fired the request and waited for the next poll
  // (up to ~1s later, longer if that poll's correction didn't
  // land immediately) to notice the position had changed. That's
  // why the bar would sit wherever the old song left it instead
  // of snapping back to 0. Resetting the clock immediately, the
  // same way seek() does, fixes that.
  // ==========================================

  const resetClockForTrackChange = () => {
    clockRef.current.position = 0;
    clockRef.current.timestamp = performance.now();
    clockRef.current.playing = false;

    setDisplayPosition(0);
    setCurrentWord(0);
  };

  const previousTrack = async () => {
    resetClockForTrackChange();

    try {
      await fetch(
        `${BRIDGE_URL}/api/previous`,
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

  const nextTrack = async () => {
    resetClockForTrackChange();

    try {
      await fetch(
        `${BRIDGE_URL}/api/next`,
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
  // CONTINUOUS ROLL PROGRESS
  //
  // Instead of only moving the word stack when
  // `currentWord` ticks over to a new integer, we track
  // how far through the current word's timing window we
  // are (0 -> 1) and use that as a fractional offset. This
  // makes the stack glide continuously in sync with actual
  // playback instead of snapping word to word.
  // ==========================================

  const currentWordObj = words[currentWord];

  let wordProgress = 0;

  if (currentWordObj) {
    const span =
      currentWordObj.end - currentWordObj.start;

    wordProgress =
      span > 0
        ? (displayPosition - currentWordObj.start) / span
        : 0;

    wordProgress = Math.min(1, Math.max(0, wordProgress));
  }

  // ==========================================
  // ONLY SHOW 3-4 WORDS AT A TIME
  // (1 before, current, 2 after)
  // ==========================================

  const PREV_WORDS = 1;
  const NEXT_WORDS = 2;

  const visibleWords = [];

  if (words.length) {
    const start =
      Math.max(
        0,
        currentWord - PREV_WORDS
      );

    const end =
      Math.min(
        words.length,
        currentWord + NEXT_WORDS + 1
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
    <main className={`app ${showLyrics ? "" : "app-no-lyrics"}`}>

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

          {/* PREVIOUS TRACK */}

          <button
            className="control-button track-button"
            onClick={previousTrack}
            aria-label="Previous track"
          >
            ⏮
          </button>


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


          {/* NEXT TRACK */}

          <button
            className="control-button track-button"
            onClick={nextTrack}
            aria-label="Next track"
          >
            ⏭
          </button>

        </div>


        {/* LYRICS TOGGLE */}

        <button
          type="button"
          className={`lyrics-label ${showLyrics ? "active" : ""}`}
          onClick={() => setShowLyrics((value) => !value)}
          aria-label="Toggle lyrics"
        >

          <span className="lyrics-icon">
            ▰
          </span>

          <span>
            Lyrics
          </span>

        </button>

      </section>


      {/* =====================================
          RIGHT LYRICS
      ====================================== */}

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

                // Subtract the fractional progress through
                // the current word so the whole stack glides
                // continuously instead of jumping in whole
                // steps.
                const rolledDistance =
                  distance - wordProgress;

                let className =
                  "lyric-word";

                if (
                  word.index ===
                  currentWord
                ) {
                  className +=
                    word.index % 2 === 0
                      ? " current-word from-left"
                      : " current-word from-right";
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
                        `${rolledDistance * 74}px`,
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

      )}

    </main>
  );
}

export default App;
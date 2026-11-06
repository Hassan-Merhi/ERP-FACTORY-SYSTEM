/**
 * Original short bell-style arrangement of the public-domain "Jingle Bells"
 * chorus. No streamed audio, third-party recording or persistent background
 * playback. All notes and the Santa greeting are created locally.
 *
 * Browser autoplay policy can reject sound after an async login/redirect.
 * The caller must show an explicit Play button when started === false.
 */
export const CHRISTMAS_JINGLE_DURATION_MS = 10_000;

export type ChristmasJinglePlayback = {
  started: boolean;
  stop: () => void;
};

type BellEvent = readonly [midi: number | null, seconds: number];

const NOTES: readonly BellEvent[] = [
  [76, 0.26],
  [76, 0.26],
  [76, 0.53],
  [null, 0.12],
  [76, 0.26],
  [76, 0.26],
  [76, 0.53],
  [null, 0.12],
  [76, 0.27],
  [79, 0.27],
  [72, 0.27],
  [74, 0.27],
  [76, 0.59],
  [null, 0.12],
  [77, 0.27],
  [77, 0.27],
  [77, 0.27],
  [77, 0.55],
  [null, 0.1],
  [77, 0.27],
  [76, 0.27],
  [76, 0.27],
  [76, 0.47],
  [null, 0.1],
  [76, 0.27],
  [74, 0.27],
  [74, 0.27],
  [76, 0.27],
  [74, 0.27],
  [79, 0.65],
];

export function christmasJingleNoteEvents(): readonly BellEvent[] {
  return NOTES;
}

function bellFrequency(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function scheduleBell(context: AudioContext, output: AudioNode, midi: number, start: number, duration: number) {
  const frequency = bellFrequency(midi);
  // Three very short decaying harmonics create a warm chime/sleigh-bell tone,
  // not the harsh sound of a continuous oscillator.
  const harmonics: ReadonlyArray<readonly [number, number]> = [
    [1, 0.067],
    [2.01, 0.018],
    [3.04, 0.009],
  ];

  for (const [ratio, volume] of harmonics) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency * ratio, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(volume, start + 0.017);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + Math.min(duration + 0.13, 0.82));
    oscillator.connect(envelope);
    envelope.connect(output);
    oscillator.start(start);
    oscillator.stop(start + Math.min(duration + 0.15, 0.84));
  }
}

function scheduleSantaHoHoHo(): { stop: () => void } {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return { stop: () => undefined };
  }
  const voice = new SpeechSynthesisUtterance("Ho! Ho! Ho!");
  voice.lang = "en-US";
  voice.rate = 0.95;
  voice.pitch = 0.58;
  voice.volume = 0.58;
  try {
    window.speechSynthesis.speak(voice);
  } catch {
    // Speech synthesis is optional; the bell melody plays independently.
  }
  return {
    stop: () => {
      // Only cancel when this exact greeting is still active.
      if (window.speechSynthesis.speaking) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* unsupported */
        }
      }
    },
  };
}

/**
 * Attempts a ten-second sound after successful, per-user authorized login.
 * Returns started:false when audio is blocked; never prevents navigation.
 */
export async function startChristmasJingle(): Promise<ChristmasJinglePlayback> {
  const silent = { started: false, stop: () => undefined };
  if (typeof window === "undefined" || typeof document === "undefined" || document.hidden) return silent;
  const AudioCtor =
    window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return silent;

  let context: AudioContext;
  try {
    context = new AudioCtor({ latencyHint: "playback" });
  } catch {
    return silent;
  }

  // A suspended audio context can remain unresolved until the next click.
  // Give the UI a chance to present its user-gesture fallback.
  let timeoutId: number | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(false), 600);
  });
  let resumed: boolean;
  try {
    resumed = await Promise.race([
      context
        .resume()
        .then(() => context.state === "running")
        .catch(() => false),
      timeout,
    ]);
  } catch {
    resumed = false;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
  if (!resumed) {
    void context.close().catch(() => undefined);
    return silent;
  }

  let disposed = false;
  let hoTimer: number | undefined;
  let endTimer: number | undefined;
  let santaVoice: { stop: () => void } | undefined;

  const stop = () => {
    if (disposed) return;
    disposed = true;
    if (hoTimer !== undefined) window.clearTimeout(hoTimer);
    if (endTimer !== undefined) window.clearTimeout(endTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", stop);
    santaVoice?.stop();
    void context.close().catch(() => undefined);
  };
  const onVisibilityChange = () => {
    if (document.hidden) stop();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", stop);

  try {
    const master = context.createGain();
    const start = context.currentTime + 0.06;
    const end = start + CHRISTMAS_JINGLE_DURATION_MS / 1000;
    master.gain.setValueAtTime(0.0001, start);
    master.gain.linearRampToValueAtTime(0.66, start + 0.09);
    master.gain.setValueAtTime(0.66, end - 0.45);
    master.gain.linearRampToValueAtTime(0.0001, end);
    master.connect(context.destination);

    let position = start + 0.08;
    for (const [midi, duration] of NOTES) {
      if (midi !== null) scheduleBell(context, master, midi, position, duration);
      position += duration;
    }

    // A soft final holiday flourish under the spoken "ho ho ho".
    scheduleBell(context, master, 84, start + 9.05, 0.38);
    scheduleBell(context, master, 79, start + 9.42, 0.42);

    hoTimer = window.setTimeout(() => {
      if (!disposed && !document.hidden) santaVoice = scheduleSantaHoHoHo();
    }, 7_700);
    endTimer = window.setTimeout(stop, CHRISTMAS_JINGLE_DURATION_MS);
    return { started: true, stop };
  } catch {
    stop();
    return silent;
  }
}

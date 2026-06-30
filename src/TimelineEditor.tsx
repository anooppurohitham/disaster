import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { getFixtureMode, type PatchedFixture } from "./App";

type Point = { time: number; value: number };
type ColorClip = { id: string; start: number; duration: number; color: string };
type ColorTransition = {
  id: string;
  start: number;
  duration: number;
  fromColor: string;
  toColor: string;
  leftClipId?: string;
  rightClipId?: string;
  boundary?: number;
};
type StrobeClip = { id: string; start: number; duration: number; rate: number };
type PulseEffect = {
  id: string;
  type: "pulse";
  start: number;
  duration: number;
  activeLength: number;
  spacingLength: number;
  intensity: number;
};
type SlopeEffect = {
  id: string;
  type: "fade" | "rise";
  start: number;
  duration: number;
  minIntensity: number;
  maxIntensity: number;
  length: number;
};
type SplineEffect = {
  id: string;
  type: "spline";
  start: number;
  duration: number;
};
type RandomEffect = {
  id: string;
  type: "random";
  start: number;
  duration: number;
  step: number;
  seed: number;
};
type IntensityEffect = PulseEffect | SlopeEffect | SplineEffect | RandomEffect;
export type TrackData = {
  points: Point[];
  colors: ColorClip[];
  colorTransitions: ColorTransition[];
  strobes: StrobeClip[];
  effects: IntensityEffect[];
  curve: "straight" | "smooth";
};
type Selection = { fixtureId: string; start: number; end: number };
type EffectType = "rise" | "fade" | "pulse" | "spline" | "random";
type FixtureGroup = { id: string; name: string; fixtureIds: string[] };
export type BeatgridPoint = { id: string; time: number; bpm: number };
type BeatgridRegion = BeatgridPoint & { row: number; width: number; nextTime: number };
export type TimelineDocumentData = {
  zoom: number;
  duration: number;
  grid: number;
  audioName: string;
  playhead: number;
  beatgrid: BeatgridPoint[];
  selectedFixtureId: string;
  fixtureOrder: string[];
  waveform: number[];
  tracks: Record<string, TrackData>;
  fixtureGroups?: FixtureGroup[];
};

type StageTab = {
  id: string;
  name: string;
};

type StagePlacement = {
  fixtureId: string;
  x: number;
  y: number;
};

type CueAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tone?: "success" | "error";
};

type ParsedCueCommand = {
  fixtureIds: string[];
  targetLabel: string;
  start: number;
  end: number;
  intensity: number | null;
  color: string | null;
  strobe: number | null;
  clearStrobe: boolean;
  intensityEffect: "pulse" | "fade" | "rise" | null;
  pulseActiveLength: number;
  pulseSpacingLength: number;
  transitionFromColor: string | null;
  transitionToColor: string | null;
};

type TimelineHistorySnapshot = {
  tracks: Record<string, TrackData>;
  duration: number;
  fixtureGroups: FixtureGroup[];
};

const LABEL_WIDTH = 240;
const COLORS = ["#3185ff", "#e246b6", "#ffb52e", "#55d982", "#f2f4f8", "#ef5350"];
const CUE_COLORS: Array<[string, string]> = [
  ["warm white", "#ffd8a8"],
  ["cool white", "#dff3ff"],
  ["deep blue", "#174cff"],
  ["light blue", "#67c8ff"],
  ["hot pink", "#ff3ca6"],
  ["magenta", "#ff00d4"],
  ["purple", "#8a42ff"],
  ["violet", "#7145ff"],
  ["orange", "#ff7a1a"],
  ["yellow", "#ffd52a"],
  ["green", "#27dc68"],
  ["cyan", "#20e0e0"],
  ["blue", "#287cff"],
  ["pink", "#ff62b7"],
  ["red", "#ff3434"],
  ["white", "#ffffff"],
  ["amber", "#ffb52e"],
  ["lime", "#a8ff38"],
];
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const snap = (time: number, grid: number) => Math.max(0, Math.round(time / grid) * grid);
const DEFAULT_TRACK_POINTS: Point[] = [{ time: 0, value: 0.25 }, { time: 8, value: 0.25 }];
type EffectEditorValues = {
  activeLength: number;
  spacingLength: number;
  intensity: number;
  minIntensity: number;
  maxIntensity: number;
  length: number;
  lengthBars: number;
  lengthMode: "time" | "bars";
};
type EffectEditorState =
  | { mode: "create"; type: EffectType; targetSelections: Selection[]; values: EffectEditorValues }
  | { mode: "edit"; fixtureId: string; effectId: string; type: EffectType; values: EffectEditorValues };
type ItemContextMenuState =
  | { kind: "color"; x: number; y: number; fixtureId: string; clipId: string }
  | { kind: "colorTransition"; x: number; y: number; fixtureId: string; transitionId: string }
  | { kind: "strobe"; x: number; y: number; fixtureId: string; clipId: string }
  | { kind: "effect"; x: number; y: number; fixtureId: string; effectId: string };
type ColorTransitionEditorState = {
  fixtureId: string;
  leftClipId: string;
  rightClipId: string;
  duration: number;
};
const rippleColors = (clips: ColorClip[], duration: number) => {
  let previousEnd = 0;
  return clips.map((clip) => {
    const start = Math.max(previousEnd, Math.min(duration, clip.start));
    const adjusted = {
      ...clip,
      start,
      duration: Math.max(0, Math.min(clip.duration, duration - start)),
    };
    previousEnd = adjusted.start + adjusted.duration;
    return adjusted;
  });
};
const clock = (time: number) =>
  `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}.${Math.floor((time % 1) * 10)}`;

export function interpolateHexColor(fromColor: string, toColor: string, progress: number) {
  const from = fromColor.replace("#", "");
  const to = toColor.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(from) || !/^[0-9a-f]{6}$/i.test(to)) {
    return progress < 0.5 ? fromColor : toColor;
  }
  const amount = Math.min(1, Math.max(0, progress));
  const channels = [0, 2, 4].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16);
    const end = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * amount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function parseCueTime(value: string) {
  const normalized = value.trim().toLowerCase();
  const clockMatch = normalized.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (clockMatch) {
    return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
  }
  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCueCommand(
  input: string,
  fixtures: PatchedFixture[],
  placements: StagePlacement[],
  selectedFixtureIds: string[],
  playhead: number,
): ParsedCueCommand {
  const normalized = input.trim().toLowerCase();
  if (!normalized) throw new Error("Type a lighting instruction first.");

  const explicitlyNamed = fixtures.filter((fixture) =>
    normalized.includes(fixture.name.toLowerCase()),
  );
  const spatialWords = {
    left: /\bleft\b/.test(normalized),
    right: /\bright\b/.test(normalized),
    front: /\bfront\b/.test(normalized),
    back: /\b(back|rear)\b/.test(normalized),
    center: /\b(center|centre|middle)\b/.test(normalized),
  };
  const hasSpatialTarget = Object.values(spatialWords).some(Boolean);
  const placementByFixtureId = new Map(
    placements.map((placement) => [placement.fixtureId, placement]),
  );

  let targets: PatchedFixture[];
  let targetLabel: string;
  if (explicitlyNamed.length) {
    targets = explicitlyNamed;
    targetLabel = explicitlyNamed.map((fixture) => fixture.name).join(", ");
  } else if (hasSpatialTarget) {
    targets = fixtures.filter((fixture) => {
      const placement = placementByFixtureId.get(fixture.id);
      if (!placement) return false;
      if (spatialWords.left && !spatialWords.right && placement.x >= 0.5) return false;
      if (spatialWords.right && !spatialWords.left && placement.x < 0.5) return false;
      if (
        spatialWords.center &&
        !spatialWords.left &&
        !spatialWords.right &&
        (placement.x < 1 / 3 || placement.x > 2 / 3)
      ) return false;
      // Stage View orientation: the top is front and the bottom is back.
      if (spatialWords.front && !spatialWords.back && placement.y >= 0.5) return false;
      if (spatialWords.back && !spatialWords.front && placement.y < 0.5) return false;
      if (
        spatialWords.center &&
        !spatialWords.front &&
        !spatialWords.back &&
        (placement.y < 1 / 3 || placement.y > 2 / 3)
      ) return false;
      return true;
    });
    targetLabel = [
      spatialWords.front ? "front" : "",
      spatialWords.back ? "back" : "",
      spatialWords.left ? "left" : "",
      spatialWords.right ? "right" : "",
      spatialWords.center ? "center" : "",
      "fixtures",
    ].filter(Boolean).join(" ");
    if (!targets.length) {
      throw new Error(`No placed fixtures match “${targetLabel}”. Arrange them in Stage View first.`);
    }
  } else if (/\b(selected|these)\b/.test(normalized) && selectedFixtureIds.length) {
    targets = fixtures.filter((fixture) => selectedFixtureIds.includes(fixture.id));
    targetLabel = "selected fixtures";
  } else {
    targets = fixtures;
    targetLabel = "all fixtures";
  }

  if (!targets.length) throw new Error("There are no fixtures to program.");

  const startMatch = normalized.match(
    /(?:\bat\b|\bfrom\b|\bstarting(?:\s+at)?\b)\s*(\d+:\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(minutes?|mins?|m\b|seconds?|secs?|s\b)?/,
  );
  const untilMatch = normalized.match(
    /\b(?:until|to)\s*(\d+:\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(minutes?|mins?|m\b|seconds?|secs?|s\b)?/,
  );
  const lengthMatch = normalized.match(
    /\bfor\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/,
  );
  const startUnitMultiplier =
    startMatch?.[2] && /^(m|mins?|minutes?)/.test(startMatch[2]) ? 60 : 1;
  const parsedStart = startMatch
    ? (parseCueTime(startMatch[1]) ?? playhead) * (
        startMatch[1].includes(":") ? 1 : startUnitMultiplier
      )
    : playhead;
  const start = Math.max(0, parsedStart ?? playhead);
  const requestedLength = lengthMatch
    ? Number(lengthMatch[1]) * (/^(m|mins?|minutes?)/.test(lengthMatch[2]) ? 60 : 1)
    : null;
  const untilUnitMultiplier =
    untilMatch?.[2] && /^(m|mins?|minutes?)/.test(untilMatch[2]) ? 60 : 1;
  const parsedUntil = untilMatch
    ? (parseCueTime(untilMatch[1]) ?? start) * (
        untilMatch[1].includes(":") ? 1 : untilUnitMultiplier
      )
    : null;
  const end = Math.max(
    start + 0.05,
    parsedUntil ?? (requestedLength !== null ? start + requestedLength : start + 4),
  );

  const clearStrobe = /\b(steady|strobe off|stop strobing|no strobe)\b/.test(normalized);
  const wantsPulse = /\b(pulse|pulsing|pulsate|pulsating|flash|flashing|blink|blinking)\b/.test(normalized);
  const wantsRise =
    /\b(fade in|fade up|rise|rising|gradually (?:turn|come) on|gradually brighten|slowly brighten)\b/.test(normalized);
  const wantsFade =
    !wantsRise &&
    /\b(fade|fading|fade out|fade down|gradually (?:turn|go) off|gradually dim|slowly dim)\b/.test(normalized);
  let intensityEffect: ParsedCueCommand["intensityEffect"] = wantsPulse
    ? "pulse"
    : wantsRise
      ? "rise"
      : wantsFade
        ? "fade"
        : null;
  const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
  let intensity: number | null = percentMatch
    ? clamp01(Number(percentMatch[1]) / 100)
    : null;
  if (!clearStrobe && /\b(off|blackout|dark)\b/.test(normalized)) intensity = 0;
  else if (/\b(full|maximum|max)\b/.test(normalized)) intensity = 1;
  else if (/\b(dim|low)\b/.test(normalized)) intensity = 0.35;
  else if (/\b(bright)\b/.test(normalized)) intensity = 0.8;
  else if (/\b(on|turn on|light up)\b/.test(normalized)) intensity = 1;

  const rawColorMentions = [
    ...CUE_COLORS.flatMap(([name, value]) => {
      const match = new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`).exec(normalized);
      return match ? [{ index: match.index, length: match[0].length, value }] : [];
    }),
    ...Array.from(normalized.matchAll(/#[0-9a-f]{6}\b/g), (match) => ({
      index: match.index ?? 0,
      length: match[0].length,
      value: match[0],
    })),
  ].sort((a, b) => a.index - b.index || b.length - a.length);
  const colorMentions = rawColorMentions.filter(
    (mention, index, mentions) =>
      !mentions.some(
        (other, otherIndex) =>
          otherIndex < index &&
          mention.index < other.index + other.length &&
          mention.index + mention.length > other.index,
      ),
  );
  const wantsColorTransition =
    colorMentions.length >= 2 &&
    (
      /\b(color transition|transition|blend|crossfade|cross fade)\b/.test(normalized) ||
      /\bfade\s+from\b/.test(normalized) ||
      /\bfrom\s+\S+\s+to\s+\S+/.test(normalized)
    );
  const transitionFromColor = wantsColorTransition ? colorMentions[0].value : null;
  const transitionToColor = wantsColorTransition ? colorMentions[1].value : null;
  const color = wantsColorTransition ? null : colorMentions[0]?.value ?? null;
  if (wantsColorTransition && intensityEffect === "fade") {
    intensityEffect = null;
  }

  // Only explicit strobe language is allowed to manipulate a fixture's strobe channel.
  const wantsStrobe = /\b(strobe|strobing)\b/.test(normalized);
  const rateMatch = normalized.match(/(\d+(?:\.\d+)?)\s*hz\b/);
  let strobe: number | null = null;
  if (wantsStrobe && !clearStrobe) {
    strobe = rateMatch
      ? Math.min(30, Math.max(0.5, Number(rateMatch[1])))
      : /\bfast\b/.test(normalized)
        ? 16
        : /\bslow\b/.test(normalized)
          ? 4
          : 8;
  }

  if ((color || strobe !== null) && intensity === null) intensity = 1;
  if (wantsColorTransition && intensity === null) intensity = 1;
  if (intensityEffect && intensity === null) intensity = 1;
  if (
    intensity === null &&
    !color &&
    strobe === null &&
    !clearStrobe &&
    !intensityEffect &&
    !wantsColorTransition
  ) {
    throw new Error(
      "I could not find an intensity, color, or strobe instruction. Try “front lights blue at 10 seconds for 4 seconds”.",
    );
  }

  return {
    fixtureIds: targets.map((fixture) => fixture.id),
    targetLabel,
    start,
    end,
    intensity,
    color,
    strobe,
    clearStrobe,
    intensityEffect,
    pulseActiveLength: /\bfast\b/.test(normalized)
      ? 0.15
      : /\bslow\b/.test(normalized)
        ? 0.75
        : 0.35,
    pulseSpacingLength: /\bfast\b/.test(normalized)
      ? 0.15
      : /\bslow\b/.test(normalized)
        ? 0.75
        : 0.35,
    transitionFromColor,
    transitionToColor,
  };
}
const documentSignature = (document: TimelineDocumentData | null) => JSON.stringify(document ?? null);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const seededRandom = (seed: number) => {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
};
const normalizePoints = (points: Point[]) =>
  [...points]
    .sort((a, b) => a.time - b.time)
    .reduce<Point[]>((result, point) => {
      const normalized = {
        time: Math.max(0, point.time),
        value: clamp01(point.value),
      };
      const previous = result[result.length - 1];
      if (previous && Math.abs(previous.time - normalized.time) < 0.0001) {
        result[result.length - 1] = normalized;
      } else {
        result.push(normalized);
      }
      return result;
    }, []);

function effectToEditorValues(effect: IntensityEffect): EffectEditorValues {
  if (effect.type === "pulse") {
    return {
      activeLength: effect.activeLength,
      spacingLength: effect.spacingLength,
      intensity: effect.intensity,
      minIntensity: 0,
      maxIntensity: effect.intensity,
      length: effect.duration,
      lengthBars: 1,
      lengthMode: "time",
    };
  }
  if (effect.type === "spline") {
    return {
      activeLength: effect.duration,
      spacingLength: 0.25,
      intensity: 1,
      minIntensity: 0,
      maxIntensity: 1,
      length: effect.duration,
      lengthBars: 1,
      lengthMode: "time",
    };
  }
  if (effect.type === "random") {
    return {
      activeLength: effect.step,
      spacingLength: effect.step,
      intensity: 1,
      minIntensity: 0,
      maxIntensity: 1,
      length: effect.duration,
      lengthBars: 1,
      lengthMode: "time",
    };
  }
  return {
    activeLength: Math.min(effect.duration, effect.length),
    spacingLength: Math.max(0.25, effect.duration - effect.length),
    intensity: effect.maxIntensity,
    minIntensity: effect.minIntensity,
    maxIntensity: effect.maxIntensity,
    length: effect.length,
    lengthBars: 1,
    lengthMode: "time",
  };
}

function createDefaultEffectEditorValues(_type: EffectType, span: number, grid: number, beatInterval: number): EffectEditorValues {
  return {
    activeLength: Math.max(grid, Math.min(span, Math.max(grid, span * 0.25))),
    spacingLength: Math.max(grid, Math.min(span, Math.max(grid, span * 0.15))),
    intensity: 1,
    minIntensity: 0,
    maxIntensity: 1,
    length: Math.max(grid, span),
    lengthBars: Math.max(1, Number((Math.max(grid, span) / Math.max(0.05, beatInterval)).toFixed(2))),
    lengthMode: "time",
  };
}

function buildEffectFromEditor(
  type: EffectType,
  start: number,
  duration: number,
  values: EffectEditorValues,
  beatInterval: number,
  effectId: string = uid(),
): IntensityEffect {
  if (type === "pulse") {
    return {
      id: effectId,
      type,
      start,
      duration,
      activeLength: Math.max(0.05, values.activeLength),
      spacingLength: Math.max(0.05, values.spacingLength),
      intensity: clamp01(values.intensity),
    };
  }
  if (type === "spline") {
    return {
      id: effectId,
      type,
      start,
      duration,
    };
  }
  if (type === "random") {
    return {
      id: effectId,
      type,
      start,
      duration,
      step: Math.max(0.05, values.lengthMode === "bars" ? values.lengthBars * Math.max(0.05, beatInterval) : values.length),
      seed: Math.random() * 100000,
    };
  }
  const resolvedLength = values.lengthMode === "bars"
    ? Math.max(0.05, values.lengthBars * Math.max(0.05, beatInterval))
    : values.length;
  return {
    id: effectId,
    type,
    start,
    duration,
    minIntensity: clamp01(values.minIntensity),
    maxIntensity: clamp01(values.maxIntensity),
    length: Math.max(0.05, Math.min(duration, resolvedLength)),
  };
}

function buildEffectPoints(effect: IntensityEffect): Point[] {
  const start = effect.start;
  const end = effect.start + effect.duration;
  if (effect.type === "pulse") {
    const points: Point[] = [{ time: start, value: 0 }];
    let cursor = start;
    while (cursor < end) {
      const activeEnd = Math.min(end, cursor + effect.activeLength);
      points.push({ time: cursor, value: effect.intensity });
      points.push({ time: activeEnd, value: effect.intensity });
      if (activeEnd < end) {
        points.push({ time: activeEnd, value: 0 });
      }
      cursor = activeEnd + effect.spacingLength;
      if (cursor < end) {
        points.push({ time: cursor, value: 0 });
      }
    }
    points.push({ time: end, value: 0 });
    return normalizePoints(points);
  }

  if (effect.type === "spline") {
    return [];
  }

  if (effect.type === "random") {
    const step = Math.max(0.05, effect.step);
    const points: Point[] = [{ time: start, value: clamp01(seededRandom(effect.seed)) }];
    let cursor = start;
    let index = 0;
    while (cursor < end) {
      const value = clamp01(seededRandom(effect.seed + index * 17.371));
      points.push({ time: cursor, value });
      const nextTime = Math.min(end, cursor + step);
      points.push({ time: nextTime, value });
      cursor = nextTime;
      index += 1;
    }
    return normalizePoints(points);
  }

  const slopeEnd = Math.min(end, start + effect.length);
  if (effect.type === "fade") {
    return normalizePoints([
      { time: start, value: effect.maxIntensity },
      { time: slopeEnd, value: effect.minIntensity },
      { time: end, value: effect.minIntensity },
    ]);
  }

  return normalizePoints([
    { time: start, value: effect.minIntensity },
    { time: slopeEnd, value: effect.maxIntensity },
    { time: end, value: effect.maxIntensity },
  ]);
}

function normalizeTrackData(track?: Partial<TrackData> | null): TrackData {
  return {
    points: normalizePoints(track?.points?.map((point) => ({ ...point })) ?? DEFAULT_TRACK_POINTS.map((point) => ({ ...point }))),
    colors: track?.colors?.map((clip) => ({ ...clip })) ?? [],
    colorTransitions: track?.colorTransitions?.map((transition) => ({ ...transition })) ?? [],
    strobes: track?.strobes?.map((clip) => ({ ...clip })) ?? [],
    effects: track?.effects?.map((effect) => ({ ...effect })) ?? [],
    curve: track?.curve ?? "straight",
  };
}

function getBeatIntervalAtTime(points: BeatgridPoint[], time: number, duration: number) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const active = [...sorted].reverse().find((point) => point.time <= time) ?? sorted[0];
  if (!active) return Math.max(0.25, duration / 16);
  return 60 / Math.max(1, active.bpm);
}

function buildIntensityPath(
  points: Point[],
  zoom: number,
  smoothAll: boolean,
  smoothRegions: Array<{ start: number; end: number }>,
) {
  if (!points.length) return "";
  const toX = (time: number) => time * zoom;
  const toY = (value: number) => (1 - value) * 150;
  const segmentShouldSmooth = (start: number, end: number) =>
    smoothAll ||
    smoothRegions.some(
      (region) => Math.max(start, region.start) <= Math.min(end, region.end),
    );

  let path = `M ${toX(points[0].time)} ${toY(points[0].value)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!segmentShouldSmooth(previous.time, current.time)) {
      path += ` L ${toX(current.time)} ${toY(current.value)}`;
      continue;
    }

    const beforePrevious = points[index - 2] ?? previous;
    const afterCurrent = points[index + 1] ?? current;
    const x0 = toX(beforePrevious.time);
    const y0 = toY(beforePrevious.value);
    const x1 = toX(previous.time);
    const y1 = toY(previous.value);
    const x2 = toX(current.time);
    const y2 = toY(current.value);
    const x3 = toX(afterCurrent.time);
    const y3 = toY(afterCurrent.value);
    const control1X = x1 + (x2 - x0) / 6;
    const control1Y = y1 + (y2 - y0) / 6;
    const control2X = x2 - (x3 - x1) / 6;
    const control2Y = y2 - (y3 - y1) / 6;
    path += ` C ${control1X} ${control1Y} ${control2X} ${control2Y} ${x2} ${y2}`;
  }
  return path;
}

export default function TimelineEditor({
  fixtures,
  onOutputFrame,
  onColorPreviewChange,
  onDocumentStateChange,
  onAudioSourceChange,
  initialAudioSourceUrl,
  requestedAudioFile,
  onRequestedAudioHandled,
  initialDocumentState,
  stagePlacements,
  stages,
  activeStageId,
  onSelectStage,
  onAddStage,
  onRenameStage,
  onRemoveStage,
  volume,
  onVolumeChange,
}: {
  fixtures: PatchedFixture[];
  onOutputFrame: (
    output: Record<
      string,
      { intensity: number; color: string | null; strobe: number | null }
    >,
  ) => void;
  onColorPreviewChange: (color: string | null) => void;
  onDocumentStateChange: (document: TimelineDocumentData) => void;
  onAudioSourceChange: (audio: { name: string; url: string; file?: File } | null) => void;
  initialAudioSourceUrl: string | null;
  requestedAudioFile: { id: string; file: File } | null;
  onRequestedAudioHandled: () => void;
  initialDocumentState: TimelineDocumentData | null;
  stagePlacements: StagePlacement[];
  stages: StageTab[];
  activeStageId: string;
  onSelectStage: (stageId: string) => void;
  onAddStage: () => void;
  onRenameStage: (stageId: string) => void;
  onRemoveStage: (stageId: string) => void;
  volume: number;
  onVolumeChange: (volume: number) => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(initialDocumentState?.zoom ?? 80);
  const [duration, setDuration] = useState(initialDocumentState?.duration ?? 60);
  const [grid, setGrid] = useState(initialDocumentState?.grid ?? 0.5);
  const [audioName, setAudioName] = useState(initialDocumentState?.audioName ?? "");
  const [playhead, setPlayhead] = useState(initialDocumentState?.playhead ?? 12);
  const [playing, setPlaying] = useState(false);
  const [transportLockEnabled, setTransportLockEnabled] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [fixtureOrder, setFixtureOrder] = useState<string[]>(
    initialDocumentState?.fixtureOrder ?? fixtures.map((fixture) => fixture.id),
  );
  const [beatgrid, setBeatgrid] = useState<BeatgridPoint[]>(
    initialDocumentState?.beatgrid?.length
      ? initialDocumentState.beatgrid
      : [{ id: "initial-tempo", time: 0, bpm: 120 }],
  );
  const [selectedFixtureId, setSelectedFixtureId] = useState(
    initialDocumentState?.selectedFixtureId ?? fixtures[0]?.id ?? "",
  );
  const [selectedFixtureIds, setSelectedFixtureIds] = useState<string[]>(
    initialDocumentState?.selectedFixtureId ? [initialDocumentState.selectedFixtureId] : fixtures[0]?.id ? [fixtures[0].id] : [],
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [selections, setSelections] = useState<Selection[]>([]);
  const [clipboard, setClipboard] = useState<TrackData | null>(null);
  const [transitionClipboard, setTransitionClipboard] = useState<ColorTransition | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [itemContextMenu, setItemContextMenu] = useState<ItemContextMenuState | null>(null);
  const [colorTransitionEditor, setColorTransitionEditor] =
    useState<ColorTransitionEditorState | null>(null);
  const [tracks, setTracks] = useState<Record<string, TrackData>>(
    Object.fromEntries(
      Object.entries(initialDocumentState?.tracks ?? {}).map(([key, value]) => [key, normalizeTrackData(value)]),
    ),
  );
  const [effectEditor, setEffectEditor] = useState<EffectEditorState | null>(null);
  const [selectedEffectKey, setSelectedEffectKey] = useState<string | null>(null);
  const [selectedColorKey, setSelectedColorKey] = useState<string | null>(null);
  const [fixtureGroups, setFixtureGroups] = useState<FixtureGroup[]>(
    initialDocumentState?.fixtureGroups ?? [],
  );
  const [cueAssistantInput, setCueAssistantInput] = useState("");
  const [cueAssistantMessages, setCueAssistantMessages] = useState<CueAssistantMessage[]>([
    {
      id: "cue-assistant-welcome",
      role: "assistant",
      text: "Try “transition all lights from blue to red from 0 to 10s” or “left lights pulse blue for 8s”.",
    },
  ]);
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [scrollPosition, setScrollPosition] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(1080);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fixtureTracksRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const pendingScrollRef = useRef(0);
  const selectionGestureRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef("");
  const loadedAudioSourceRef = useRef<string | null>(null);
  const requestedAudioIdRef = useRef<string | null>(null);
  const undoStackRef = useRef<TimelineHistorySnapshot[]>([]);
  const redoStackRef = useRef<TimelineHistorySnapshot[]>([]);
  const hydratingDocumentRef = useRef(false);
  const hydrationFrameRef = useRef<number | null>(null);
  const lastEmittedDocumentSignatureRef = useRef<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(
    initialDocumentState?.waveform?.length
      ? initialDocumentState.waveform
      : Array.from({ length: 180 }, (_, index) =>
          0.15 + Math.abs(Math.sin(index * 0.41) * Math.cos(index * 0.13)) * 0.7,
        ),
  );
  const timelineScale = Math.max(
    zoom,
    Math.max(1, viewportWidth - LABEL_WIDTH) / Math.max(1, duration),
  );
  const contentWidth = duration * timelineScale;
  const beatTimes = getBeatTimes(beatgrid, duration);
  const fixtureGroupByFixtureId = new Map<string, FixtureGroup>();
  fixtureGroups.forEach((group) =>
    group.fixtureIds.forEach((fixtureId) => fixtureGroupByFixtureId.set(fixtureId, group)),
  );

  function makeDefaultTrackData(): TrackData {
    return normalizeTrackData();
  }

  function isNeutralTrackData(track?: TrackData) {
    if (!track) return true;
    if (
      track.colors.length ||
      track.colorTransitions.length ||
      track.strobes.length ||
      track.effects.length ||
      track.curve !== "straight"
    ) return false;
    if (track.points.length !== DEFAULT_TRACK_POINTS.length) return false;
    return track.points.every(
      (point, index) =>
        point.time === DEFAULT_TRACK_POINTS[index].time &&
        point.value === DEFAULT_TRACK_POINTS[index].value,
    );
  }

  function evaluateTrackAtPlayhead(data: TrackData | undefined, currentPlayhead: number) {
    if (!data) {
      return { intensity: 0, color: null, strobe: null };
    }
    const points = [...data.points].sort((a, b) => a.time - b.time);
    const afterIndex = points.findIndex((point) => point.time >= currentPlayhead);
    const after = afterIndex < 0 ? points[points.length - 1] : points[afterIndex];
    const before = afterIndex <= 0 ? points[0] : points[afterIndex - 1];
    const progress = before && after && after.time !== before.time
      ? (currentPlayhead - before.time) / (after.time - before.time)
      : 0;
    const intensity = before && after
      ? before.value + (after.value - before.value) * Math.min(1, Math.max(0, progress))
      : 0;
    const activeTransition = [...data.colorTransitions].reverse().find(
      (transition) =>
        currentPlayhead >= transition.start &&
        currentPlayhead < transition.start + transition.duration,
    );
    const solidColor = [...data.colors].reverse().find(
      (clip) => currentPlayhead >= clip.start && currentPlayhead < clip.start + clip.duration,
    )?.color ?? null;
    const color = activeTransition
      ? interpolateHexColor(
          activeTransition.fromColor,
          activeTransition.toColor,
          (currentPlayhead - activeTransition.start) / Math.max(0.001, activeTransition.duration),
        )
      : solidColor;
    const strobe = [...data.strobes].reverse().find(
      (clip) => currentPlayhead >= clip.start && currentPlayhead < clip.start + clip.duration,
    )?.rate ?? null;
    return { intensity, color, strobe };
  }

  function getSelectionsFromMarquee(
    startClientX: number,
    startClientY: number,
    endClientX: number,
    endClientY: number,
  ) {
    const top = Math.min(startClientY, endClientY);
    const bottom = Math.max(startClientY, endClientY);
    const left = Math.min(startClientX, endClientX);
    const right = Math.max(startClientX, endClientX);
    const lanes = fixtureTracksRef.current?.querySelectorAll<HTMLElement>(".curveLane");
    if (!lanes?.length) return [];

    return Array.from(lanes)
      .map((lane) => {
        const bounds = lane.getBoundingClientRect();
        if (bounds.bottom < top || bounds.top > bottom) return null;
        const fixtureId = lane.closest<HTMLElement>("[data-fixture-id]")?.dataset.fixtureId;
        if (!fixtureId) return null;
        const laneStartPx = Math.max(0, Math.min(bounds.width, left - bounds.left));
        const laneEndPx = Math.max(0, Math.min(bounds.width, right - bounds.left));
        const rawStart = Math.min(duration, Math.max(0, laneStartPx / timelineScale));
        const rawEnd = Math.min(duration, Math.max(0, laneEndPx / timelineScale));
        const snappedStart = Math.min(duration, snap(rawStart, grid));
        const snappedEnd = Math.min(duration, snap(rawEnd, grid));
        return {
          fixtureId,
          start: snappedStart,
          end: snappedEnd,
        } satisfies Selection;
      })
      .filter((selection): selection is Selection => Boolean(selection))
      .filter(
        (selection) => Math.abs(selection.end - selection.start) > Math.max(grid * 0.25, 0.02),
      );
  }

  useEffect(() => {
    const incomingDocumentSignature = documentSignature(initialDocumentState);
    if (incomingDocumentSignature === lastEmittedDocumentSignatureRef.current) {
      return;
    }

    hydratingDocumentRef.current = true;
    if (hydrationFrameRef.current !== null) {
      cancelAnimationFrame(hydrationFrameRef.current);
    }

    setZoom(initialDocumentState?.zoom ?? 80);
    setDuration(initialDocumentState?.duration ?? 60);
    setGrid(initialDocumentState?.grid ?? 0.5);
    setAudioName(initialDocumentState?.audioName ?? "");
    setPlayhead(initialDocumentState?.playhead ?? 12);
    setPlaying(false);
    setStopArmed(false);
    setFixtureOrder(
      initialDocumentState?.fixtureOrder ?? fixtures.map((fixture) => fixture.id),
    );
    setBeatgrid(
      initialDocumentState?.beatgrid?.length
        ? initialDocumentState.beatgrid
        : [{ id: "initial-tempo", time: 0, bpm: 120 }],
    );
    setSelectedFixtureId(
      initialDocumentState?.selectedFixtureId ?? fixtures[0]?.id ?? "",
    );
    setSelectedFixtureIds(
      initialDocumentState?.selectedFixtureId
        ? [initialDocumentState.selectedFixtureId]
        : fixtures[0]?.id
          ? [fixtures[0].id]
          : [],
    );
    setSelectionMode(false);
    setSelections([]);
    setClipboard(null);
    setTransitionClipboard(null);
    setContextMenu(null);
    setItemContextMenu(null);
    setColorTransitionEditor(null);
    setTracks(
      Object.fromEntries(
        Object.entries(initialDocumentState?.tracks ?? {}).map(([key, value]) => [key, normalizeTrackData(value)]),
      ),
    );
    setFixtureGroups(initialDocumentState?.fixtureGroups ?? []);
    setExpandedGroupIds([]);
    setEffectEditor(null);
    setSelectedEffectKey(null);
    setSelectedColorKey(null);
    setScrollPosition(0);
    setWaveform(
      initialDocumentState?.waveform?.length
        ? initialDocumentState.waveform
        : Array.from({ length: 180 }, (_, index) =>
            0.15 + Math.abs(Math.sin(index * 0.41) * Math.cos(index * 0.13)) * 0.7,
          ),
    );
    undoStackRef.current = [];
    redoStackRef.current = [];
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.style.setProperty("--track-scroll", "0px");
    }

    if (!initialAudioSourceUrl && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioUrlRef.current = "";
      loadedAudioSourceRef.current = null;
    }

    hydrationFrameRef.current = requestAnimationFrame(() => {
      hydratingDocumentRef.current = false;
      hydrationFrameRef.current = null;
    });

    return () => {
      if (hydrationFrameRef.current !== null) {
        cancelAnimationFrame(hydrationFrameRef.current);
        hydrationFrameRef.current = null;
      }
    };
  }, [initialDocumentState, initialAudioSourceUrl, fixtures]);

  useEffect(() => {
    if (!audioRef.current || !initialAudioSourceUrl) return;
    if (loadedAudioSourceRef.current !== initialAudioSourceUrl) {
      audioRef.current.src = initialAudioSourceUrl;
      audioRef.current.load();
      loadedAudioSourceRef.current = initialAudioSourceUrl;
    }
    audioUrlRef.current = initialAudioSourceUrl;
  }, [initialAudioSourceUrl]);

  useEffect(() => {
    if (
      !requestedAudioFile ||
      requestedAudioIdRef.current === requestedAudioFile.id
    ) {
      return;
    }
    requestedAudioIdRef.current = requestedAudioFile.id;
    void loadAudio(requestedAudioFile.file).finally(onRequestedAudioHandled);
  }, [requestedAudioFile?.id]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
    audioRef.current.muted = false;
  }, [volume]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maximumScroll = Math.max(
      0,
      LABEL_WIDTH + contentWidth - viewport.clientWidth,
    );
    if (viewport.scrollLeft > maximumScroll) {
      viewport.scrollLeft = maximumScroll;
      setScrollPosition(maximumScroll);
    }
  }, [contentWidth, viewportWidth]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const playheadX = LABEL_WIDTH + playhead * timelineScale;
    const visibleLeft = viewport.scrollLeft;
    const visibleRight = visibleLeft + viewport.clientWidth;
    const rightPadding = Math.min(220, Math.max(120, viewport.clientWidth * 0.18));
    const leftPadding = 80;
    const maximumScroll = Math.max(
      0,
      LABEL_WIDTH + contentWidth - viewport.clientWidth,
    );

    if (playheadX > visibleRight - rightPadding) {
      const nextScroll = Math.min(
        maximumScroll,
        Math.max(0, playheadX - viewport.clientWidth + rightPadding),
      );
      if (Math.abs(nextScroll - viewport.scrollLeft) > 1) {
        viewport.scrollLeft = nextScroll;
        setScrollPosition(nextScroll);
      }
      return;
    }

    if (playheadX < visibleLeft + leftPadding) {
      const nextScroll = Math.max(0, playheadX - leftPadding);
      if (Math.abs(nextScroll - viewport.scrollLeft) > 1) {
        viewport.scrollLeft = nextScroll;
        setScrollPosition(nextScroll);
      }
    }
  }, [playhead, timelineScale, contentWidth]);

  useEffect(() => {
    setTracks((previous) => {
      const next = { ...previous };
      fixtures.forEach((fixture) => {
        next[fixture.id] ??= {
          ...makeDefaultTrackData(),
        };
      });
      fixtureGroups.forEach((group) => {
        next[group.id] ??= makeDefaultTrackData();
      });
      return next;
    });
    setFixtureOrder((previous) => [
      ...previous.filter((id) => fixtures.some((fixture) => fixture.id === id)),
      ...fixtures.map((fixture) => fixture.id).filter((id) => !previous.includes(id)),
    ]);
  }, [fixtures, fixtureGroups]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.style.setProperty("--track-scroll", "0px");
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleNativeWheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomAroundClientX(zoom - event.deltaY * 0.12, event.clientX);
    };

    viewport.addEventListener("wheel", handleNativeWheel, {
      passive: false,
      capture: true,
    });

    return () => {
      viewport.removeEventListener("wheel", handleNativeWheel, true);
    };
  }, [zoom, timelineScale, duration]);

  useEffect(() => {
    const handleRootAltWheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      if (!rootRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomAroundClientX(zoom - event.deltaY * 0.12, event.clientX);
    };

    window.addEventListener("wheel", handleRootAltWheel, {
      passive: false,
      capture: true,
    });

    return () => {
      window.removeEventListener("wheel", handleRootAltWheel, true);
    };
  }, [zoom, timelineScale, duration]);

  useEffect(() => () => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio?.src) {
        setPlayhead(audio.currentTime);
        if (audio.ended) setPlaying(false);
      } else {
        setPlayhead((time) => (time >= duration ? 0 : time + 0.05));
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, duration]);

  useEffect(() => {
    if (hydratingDocumentRef.current) return;
    const output: Record<
      string,
      { intensity: number; color: string | null; strobe: number | null }
    > = {};
    fixtures.forEach((fixture) => {
      const group = fixtureGroupByFixtureId.get(fixture.id);
      if (!group) {
        output[fixture.id] = evaluateTrackAtPlayhead(tracks[fixture.id], playhead);
        return;
      }
      const groupOutput = evaluateTrackAtPlayhead(tracks[group.id], playhead);
      const fixtureTrack = tracks[fixture.id];
      const individualOutput = evaluateTrackAtPlayhead(fixtureTrack, playhead);
      output[fixture.id] = {
        intensity: isNeutralTrackData(fixtureTrack) ? groupOutput.intensity : individualOutput.intensity,
        color:
          fixtureTrack?.colors.length || fixtureTrack?.colorTransitions.length
            ? individualOutput.color
            : groupOutput.color,
        strobe: fixtureTrack?.strobes.length ? individualOutput.strobe : groupOutput.strobe,
      };
    });
    onOutputFrame(output);
  }, [playhead, tracks, fixtures, fixtureGroups]);

  useEffect(() => {
    if (hydratingDocumentRef.current) return;
    const document = {
      zoom,
      duration,
      grid,
      audioName,
      playhead,
      beatgrid,
      selectedFixtureId,
      fixtureOrder,
      waveform,
      tracks,
      fixtureGroups,
    } satisfies TimelineDocumentData;
    lastEmittedDocumentSignatureRef.current = documentSignature(document);
    onDocumentStateChange(document);
  }, [
    zoom,
    duration,
    grid,
    audioName,
    playhead,
    beatgrid,
    selectedFixtureId,
    fixtureOrder,
    waveform,
    tracks,
    fixtureGroups,
    onDocumentStateChange,
  ]);

  function updateTrack(fixtureId: string, data: TrackData) {
    undoStackRef.current.push({ tracks, duration, fixtureGroups });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = [];
    setTracks((previous) => ({
      ...previous,
      [fixtureId]: normalizeTrackData(data),
    }));
  }

  function commitTracks(nextTracks: Record<string, TrackData>) {
    undoStackRef.current.push({ tracks, duration, fixtureGroups });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = [];
    setTracks(nextTracks);
  }

  function submitCueAssistantCommand() {
    const input = cueAssistantInput.trim();
    if (!input) return;
    const userMessage: CueAssistantMessage = {
      id: uid(),
      role: "user",
      text: input,
    };

    try {
      const command = parseCueCommand(
        input,
        fixtures,
        stagePlacements,
        selectedFixtureIds,
        playhead,
      );
      const nextDuration = Math.max(duration, Math.ceil(command.end + 1));
      const nextTracks = { ...tracks };
      const epsilon = Math.min(0.01, grid / 10);

      command.fixtureIds.forEach((fixtureId) => {
        const track = normalizeTrackData(nextTracks[fixtureId]);
        const regionStart = command.start;
        const regionEnd = command.end;
        const overlapsRegion = (start: number, clipDuration: number) =>
          start < regionEnd && start + clipDuration > regionStart;

        let points = track.points;
        if (command.intensity !== null && !command.intensityEffect) {
          const beforeValue = evaluateTrackAtPlayhead(track, Math.max(0, regionStart - epsilon));
          const afterValue = evaluateTrackAtPlayhead(track, Math.min(duration, regionEnd + epsilon));
          points = [
            ...track.points.filter(
              (point) => point.time < regionStart - epsilon || point.time > regionEnd + epsilon,
            ),
            { time: Math.max(0, regionStart - epsilon), value: beforeValue.intensity },
            { time: regionStart, value: command.intensity },
            { time: regionEnd, value: command.intensity },
            ...(regionEnd < nextDuration
              ? [{ time: regionEnd + epsilon, value: afterValue.intensity }]
              : []),
          ];
        }

        const colors = command.color
          ? [
              ...track.colors.filter((clip) => !overlapsRegion(clip.start, clip.duration)),
              {
                id: uid(),
                start: regionStart,
                duration: regionEnd - regionStart,
                color: command.color,
              },
            ]
          : track.colors;
        const colorTransitions =
          command.transitionFromColor && command.transitionToColor
            ? [
                ...track.colorTransitions.filter(
                  (transition) =>
                    !overlapsRegion(transition.start, transition.duration),
                ),
                {
                  id: uid(),
                  start: regionStart,
                  duration: regionEnd - regionStart,
                  fromColor: command.transitionFromColor,
                  toColor: command.transitionToColor,
                },
              ]
            : command.color
              ? track.colorTransitions.filter(
                  (transition) =>
                    !overlapsRegion(transition.start, transition.duration),
                )
              : track.colorTransitions;
        const strobes = command.strobe !== null
          ? [
              ...track.strobes.filter((clip) => !overlapsRegion(clip.start, clip.duration)),
              {
                id: uid(),
                start: regionStart,
                duration: regionEnd - regionStart,
                rate: command.strobe,
              },
            ]
          : command.clearStrobe || command.intensityEffect === "pulse"
            ? track.strobes.filter((clip) => !overlapsRegion(clip.start, clip.duration))
            : track.strobes;

        let nextTrack = normalizeTrackData({
          ...track,
          points,
          colors,
          colorTransitions,
          strobes,
          effects: command.intensityEffect
            ? track.effects.filter((effect) => !overlapsRegion(effect.start, effect.duration))
            : track.effects,
        });

        if (command.intensityEffect) {
          const effectDuration = regionEnd - regionStart;
          const effect: IntensityEffect = command.intensityEffect === "pulse"
            ? {
                id: uid(),
                type: "pulse",
                start: regionStart,
                duration: effectDuration,
                activeLength: command.pulseActiveLength,
                spacingLength: command.pulseSpacingLength,
                intensity: command.intensity ?? 1,
              }
            : {
                id: uid(),
                type: command.intensityEffect,
                start: regionStart,
                duration: effectDuration,
                minIntensity: 0,
                maxIntensity: command.intensity ?? 1,
                length: effectDuration,
              };
          nextTrack = applyEffectToTrack(nextTrack, effect);
        }

        nextTracks[fixtureId] = nextTrack;
      });

      commitTracks(nextTracks);
      if (nextDuration > duration) setDuration(nextDuration);
      setPlayhead(command.start);
      setSelectedFixtureIds(command.fixtureIds);
      setSelectedFixtureId(command.fixtureIds[0] ?? selectedFixtureId);
      const details = [
        command.intensityEffect === "pulse" ? "intensity pulse" : "",
        command.intensityEffect === "fade" ? "gradual fade out" : "",
        command.intensityEffect === "rise" ? "gradual fade in" : "",
        command.transitionFromColor && command.transitionToColor
          ? `${command.transitionFromColor.toUpperCase()} → ${command.transitionToColor.toUpperCase()} color transition`
          : "",
        command.intensity !== null && !command.intensityEffect
          ? `${Math.round(command.intensity * 100)}% intensity`
          : "",
        command.color ? command.color.toUpperCase() : "",
        command.strobe !== null ? `${command.strobe} Hz strobe` : "",
        command.clearStrobe ? "steady" : "",
      ].filter(Boolean).join(", ");
      setCueAssistantMessages((previous) => [
        ...previous,
        userMessage,
        {
          id: uid(),
          role: "assistant",
          tone: "success",
          text: `Applied ${details} to ${command.fixtureIds.length} ${command.targetLabel} from ${clock(command.start)} to ${clock(command.end)}.`,
        },
      ]);
      setCueAssistantInput("");
    } catch (error) {
      setCueAssistantMessages((previous) => [
        ...previous,
        userMessage,
        {
          id: uid(),
          role: "assistant",
          tone: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  }

  function selectSingleFixture(fixtureId: string) {
    setSelectedFixtureId(fixtureId);
    setSelectedFixtureIds([fixtureId]);
  }

  function selectFixtureGroup(group: FixtureGroup) {
    setSelectedFixtureId(group.id);
    setSelectedFixtureIds(group.fixtureIds);
  }

  function createFixtureGroup() {
    const uniqueSelection = Array.from(new Set(selectedFixtureIds));
    if (uniqueSelection.length < 2) return;
    if (uniqueSelection.some((fixtureId) => fixtureGroupByFixtureId.has(fixtureId))) return;
    const orderedSelection = fixtureOrder.filter((fixtureId) => uniqueSelection.includes(fixtureId));
    const leadFixtureId = orderedSelection[0];
    const leadFixture = fixtures.find((fixture) => fixture.id === leadFixtureId);
    if (!leadFixture) return;
    const group: FixtureGroup = {
      id: `group:${uid()}`,
      name: `${leadFixture.name} Group`,
      fixtureIds: orderedSelection,
    };
    undoStackRef.current.push({ tracks, duration, fixtureGroups });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = [];
    setFixtureGroups((previous) => [...previous, group]);
    setTracks((previous) => {
      const next = { ...previous, [group.id]: previous[leadFixtureId] ?? makeDefaultTrackData() };
      orderedSelection.forEach((fixtureId) => {
        next[fixtureId] = makeDefaultTrackData();
      });
      return next;
    });
    setExpandedGroupIds((previous) => [...previous, group.id]);
    setSelectedFixtureId(group.id);
    setSelectedFixtureIds(orderedSelection);
  }

  function ungroupSelectedFixtures() {
    const groupsToRemove = fixtureGroups.filter((group) =>
      group.fixtureIds.some((fixtureId) => selectedFixtureIds.includes(fixtureId)) ||
      selectedFixtureId === group.id,
    );
    if (!groupsToRemove.length) return;
    undoStackRef.current.push({ tracks, duration, fixtureGroups });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = [];
    const groupIdsToRemove = new Set(groupsToRemove.map((group) => group.id));
    setFixtureGroups((previous) => previous.filter((group) => !groupIdsToRemove.has(group.id)));
    setExpandedGroupIds((previous) => previous.filter((groupId) => !groupIdsToRemove.has(groupId)));
    setTracks((previous) => {
      const next = { ...previous };
      groupsToRemove.forEach((group) => {
        const groupTrack = next[group.id];
        group.fixtureIds.forEach((fixtureId) => {
          if (isNeutralTrackData(next[fixtureId]) && groupTrack) {
            next[fixtureId] = {
              curve: groupTrack.curve,
              points: groupTrack.points.map((point) => ({ ...point })),
              colors: groupTrack.colors.map((clip) => ({ ...clip })),
              colorTransitions: groupTrack.colorTransitions.map((transition) => ({ ...transition })),
              strobes: groupTrack.strobes.map((clip) => ({ ...clip })),
              effects: groupTrack.effects.map((effect) => ({ ...effect })),
            };
          }
        });
        delete next[group.id];
      });
      return next;
    });
    if (groupsToRemove.some((group) => group.id === selectedFixtureId)) {
      setSelectedFixtureId(groupsToRemove[0].fixtureIds[0] ?? fixtures[0]?.id ?? "");
    }
  }

  function undoLastChange() {
    const previous = undoStackRef.current.pop();
    if (previous) {
      redoStackRef.current.push({ tracks, duration, fixtureGroups });
      setTracks(previous.tracks);
      setDuration(previous.duration);
      setFixtureGroups(previous.fixtureGroups);
      return true;
    }
    return false;
  }

  function redoLastChange() {
    const next = redoStackRef.current.pop();
    if (next) {
      undoStackRef.current.push({ tracks, duration, fixtureGroups });
      setTracks(next.tracks);
      setDuration(next.duration);
      setFixtureGroups(next.fixtureGroups);
      return true;
    }
    return false;
  }

  function addHistoryMessage(action: "Undid" | "Redid") {
    setCueAssistantMessages((previous) => [
      ...previous,
      {
        id: uid(),
        role: "assistant",
        tone: "success",
        text: `${action} the last timeline change.`,
      },
    ]);
  }

  function applyEffectToTrack(track: TrackData, effect: IntensityEffect) {
    const regionStart = effect.start;
    const regionEnd = effect.start + effect.duration;
    const nextEffects = [...track.effects.filter((item) => item.id !== effect.id), effect]
      .sort((a, b) => a.start - b.start);
    const preservedPoints = track.points.filter(
      (point) =>
        point.time < regionStart ||
        point.time > regionEnd ||
        track.effects.some(
          (existing) =>
            existing.id !== effect.id &&
            point.time >= existing.start &&
            point.time <= existing.start + existing.duration,
        ),
    );
    return normalizeTrackData({
      ...track,
      effects: nextEffects,
      points: [...preservedPoints, ...buildEffectPoints(effect)],
    });
  }

  function removeEffectFromTrack(track: TrackData, effectId: string) {
    const effectToRemove = track.effects.find((effect) => effect.id === effectId);
    if (!effectToRemove) return track;
    const remainingEffects = track.effects.filter((effect) => effect.id !== effectId);
    const preservedPoints = track.points.filter(
      (point) =>
        point.time < effectToRemove.start ||
        point.time > effectToRemove.start + effectToRemove.duration ||
        remainingEffects.some(
          (effect) =>
            point.time >= effect.start &&
            point.time <= effect.start + effect.duration,
        ),
    );
    return normalizeTrackData({
      ...track,
      effects: remainingEffects,
      points: preservedPoints,
    });
  }

  function openCreateEffectDialog(type: EffectType) {
    if (!selections.length) return;
    if (type === "spline" || type === "random") {
      const nextTracks = { ...tracks };
      selections.forEach((selection) => {
        const track = nextTracks[selection.fixtureId];
        if (!track) return;
        const start = Math.min(selection.start, selection.end);
        const end = Math.max(selection.start, selection.end);
        const effect: IntensityEffect =
          type === "spline"
            ? {
                id: uid(),
                type: "spline",
                start,
                duration: Math.max(grid, end - start),
              }
            : {
                id: uid(),
                type: "random",
                start,
                duration: Math.max(grid, end - start),
                step: grid,
                seed: Math.random() * 100000,
              };
        if (type === "spline") {
          const startValue = evaluateTrackAtPlayhead(track, start).intensity;
          const endValue = evaluateTrackAtPlayhead(track, end).intensity;
          nextTracks[selection.fixtureId] = normalizeTrackData({
            ...track,
            effects: [...track.effects, effect],
            points: [
              ...track.points.filter((point) => point.time < start || point.time > end),
              { time: start, value: startValue },
              { time: end, value: endValue },
            ],
          });
        } else {
          nextTracks[selection.fixtureId] = applyEffectToTrack(track, effect);
        }
        setSelectedEffectKey(`${selection.fixtureId}:${effect.id}`);
      });
      commitTracks(nextTracks);
      return;
    }
    const lastSelection = selections[selections.length - 1];
    const span = Math.max(grid, Math.abs(lastSelection.end - lastSelection.start));
    const beatInterval = getBeatIntervalAtTime(beatgrid, Math.min(lastSelection.start, lastSelection.end), duration);
    setEffectEditor({
      mode: "create",
      type,
      targetSelections: selections,
      values: createDefaultEffectEditorValues(type, span, grid, beatInterval),
    });
  }

  function openEditEffectDialog(fixtureId: string, effect: IntensityEffect) {
    setSelectedEffectKey(`${fixtureId}:${effect.id}`);
    setSelectedFixtureId(fixtureId);
    setSelectedFixtureIds([fixtureId]);
    if (effect.type === "spline" || effect.type === "random") {
      setEffectEditor(null);
      return;
    }
    const beatInterval = getBeatIntervalAtTime(beatgrid, effect.start, duration);
    const values = effectToEditorValues(effect);
    setEffectEditor({
      mode: "edit",
      fixtureId,
      effectId: effect.id,
      type: effect.type,
      values: {
        ...values,
        lengthBars: Math.max(1, Number((values.length / Math.max(0.05, beatInterval)).toFixed(2))),
      },
    });
  }

  function submitEffectEditor() {
    if (!effectEditor) return;
    if (effectEditor.mode === "create") {
      const nextTracks = { ...tracks };
      effectEditor.targetSelections.forEach((selection) => {
        const track = nextTracks[selection.fixtureId];
        if (!track) return;
        const start = Math.min(selection.start, selection.end);
        const end = Math.max(selection.start, selection.end);
        const beatInterval = getBeatIntervalAtTime(beatgrid, start, duration);
        const effect = buildEffectFromEditor(
          effectEditor.type,
          start,
          Math.max(grid, end - start),
          effectEditor.values,
          beatInterval,
        );
        nextTracks[selection.fixtureId] = applyEffectToTrack(track, effect);
        setSelectedEffectKey(`${selection.fixtureId}:${effect.id}`);
      });
      commitTracks(nextTracks);
      setEffectEditor(null);
      return;
    }

    const source = tracks[effectEditor.fixtureId];
    if (!source) return;
    const existing = source.effects.find((effect) => effect.id === effectEditor.effectId);
    if (!existing) return;
    const beatInterval = getBeatIntervalAtTime(beatgrid, existing.start, duration);
    const updated = buildEffectFromEditor(
      effectEditor.type,
      existing.start,
      existing.duration,
      effectEditor.values,
      beatInterval,
      existing.id,
    );
    updateTrack(effectEditor.fixtureId, applyEffectToTrack(source, updated));
    setSelectedEffectKey(`${effectEditor.fixtureId}:${effectEditor.effectId}`);
    setEffectEditor(null);
  }

  function deleteEditingEffect() {
    if (!effectEditor || effectEditor.mode !== "edit") return;
    const source = tracks[effectEditor.fixtureId];
    if (!source) return;
    updateTrack(effectEditor.fixtureId, removeEffectFromTrack(source, effectEditor.effectId));
    setSelectedEffectKey(null);
    setEffectEditor(null);
  }

  function openColorTransitionEditor(
    fixtureId: string,
    leftClipId: string,
    rightClipId: string,
  ) {
    setColorTransitionEditor({
      fixtureId,
      leftClipId,
      rightClipId,
      duration: Math.max(0.1, grid),
    });
  }

  function submitColorTransition() {
    if (!colorTransitionEditor) return;
    const track = tracks[colorTransitionEditor.fixtureId];
    if (!track) return;
    const leftClip = track.colors.find(
      (clip) => clip.id === colorTransitionEditor.leftClipId,
    );
    const rightClip = track.colors.find(
      (clip) => clip.id === colorTransitionEditor.rightClipId,
    );
    if (!leftClip || !rightClip) {
      setColorTransitionEditor(null);
      return;
    }

    const boundary = leftClip.start + leftClip.duration;
    const maximumHalf = Math.max(
      0,
      Math.min(leftClip.duration - 0.05, rightClip.duration - 0.05),
    );
    const halfDuration = Math.min(
      Math.max(0.05, colorTransitionEditor.duration / 2),
      maximumHalf,
    );
    if (halfDuration <= 0) {
      setColorTransitionEditor(null);
      return;
    }

    const transition: ColorTransition = {
      id: uid(),
      start: boundary - halfDuration,
      duration: halfDuration * 2,
      fromColor: leftClip.color,
      toColor: rightClip.color,
      leftClipId: leftClip.id,
      rightClipId: rightClip.id,
      boundary,
    };
    updateTrack(colorTransitionEditor.fixtureId, {
      ...track,
      colors: track.colors.map((clip) => {
        if (clip.id === leftClip.id) {
          return { ...clip, duration: Math.max(0.05, clip.duration - halfDuration) };
        }
        if (clip.id === rightClip.id) {
          return {
            ...clip,
            start: clip.start + halfDuration,
            duration: Math.max(0.05, clip.duration - halfDuration),
          };
        }
        return clip;
      }),
      colorTransitions: [...track.colorTransitions, transition].sort(
        (a, b) => a.start - b.start,
      ),
    });
    setColorTransitionEditor(null);
  }

  function copyTransitionFromContextMenu() {
    if (!itemContextMenu || itemContextMenu.kind !== "colorTransition") return;
    const transition = tracks[itemContextMenu.fixtureId]?.colorTransitions.find(
      (item) => item.id === itemContextMenu.transitionId,
    );
    if (!transition) return;
    setTransitionClipboard({
      id: transition.id,
      start: 0,
      duration: transition.duration,
      fromColor: transition.fromColor,
      toColor: transition.toColor,
    });
    setItemContextMenu(null);
  }

  function pasteTransitionAtPlayhead() {
    if (!transitionClipboard) return;
    const fixtureId =
      itemContextMenu?.fixtureId ?? selectedFixtureId;
    const track = tracks[fixtureId];
    if (!track) return;
    updateTrack(fixtureId, {
      ...track,
      colorTransitions: [
        ...track.colorTransitions,
        {
          ...transitionClipboard,
          id: uid(),
          start: Math.min(
            Math.max(0, playhead),
            Math.max(0, duration - transitionClipboard.duration),
          ),
        },
      ].sort((a, b) => a.start - b.start),
    });
    setItemContextMenu(null);
    setContextMenu(null);
  }

  function deleteItemFromContextMenu() {
    if (!itemContextMenu) return;
    const track = tracks[itemContextMenu.fixtureId];
    if (!track) return;

    if (itemContextMenu.kind === "color") {
      updateTrack(itemContextMenu.fixtureId, {
        ...track,
        colors: track.colors.filter((clip) => clip.id !== itemContextMenu.clipId),
      });
      if (selectedColorKey === `${itemContextMenu.fixtureId}:${itemContextMenu.clipId}`) {
        setSelectedColorKey(null);
      }
    } else if (itemContextMenu.kind === "colorTransition") {
      const transition = track.colorTransitions.find(
        (item) => item.id === itemContextMenu.transitionId,
      );
      updateTrack(itemContextMenu.fixtureId, {
        ...track,
        colors: transition?.leftClipId && transition.rightClipId && transition.boundary !== undefined
          ? track.colors.map((clip) => {
              if (clip.id === transition.leftClipId) {
                return {
                  ...clip,
                  duration: Math.max(0.05, transition.boundary! - clip.start),
                };
              }
              if (clip.id === transition.rightClipId) {
                const end = clip.start + clip.duration;
                return {
                  ...clip,
                  start: transition.boundary!,
                  duration: Math.max(0.05, end - transition.boundary!),
                };
              }
              return clip;
            })
          : track.colors,
        colorTransitions: track.colorTransitions.filter(
          (transition) => transition.id !== itemContextMenu.transitionId,
        ),
      });
    } else if (itemContextMenu.kind === "strobe") {
      updateTrack(itemContextMenu.fixtureId, {
        ...track,
        strobes: track.strobes.filter((clip) => clip.id !== itemContextMenu.clipId),
      });
    } else {
      updateTrack(itemContextMenu.fixtureId, removeEffectFromTrack(track, itemContextMenu.effectId));
      if (selectedEffectKey === `${itemContextMenu.fixtureId}:${itemContextMenu.effectId}`) {
        setSelectedEffectKey(null);
      }
    }

    setItemContextMenu(null);
  }

  function copySelection() {
    const selection = selections[selections.length - 1] ?? null;
    if (!selection) return;
    const source = tracks[selection.fixtureId];
    if (!source) return;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    setClipboard({
      curve: source.curve,
      points: source.points.filter((point) => point.time >= start && point.time <= end)
        .map((point) => ({ ...point, time: point.time - start })),
      colors: source.colors.filter((clip) => clip.start < end && clip.start + clip.duration > start)
        .map((clip) => ({ ...clip, id: uid(), start: Math.max(0, clip.start - start) })),
      colorTransitions: source.colorTransitions
        .filter(
          (transition) =>
            transition.start < end &&
            transition.start + transition.duration > start,
        )
        .map((transition) => ({
          id: uid(),
          start: Math.max(0, transition.start - start),
          duration: transition.duration,
          fromColor: transition.fromColor,
          toColor: transition.toColor,
        })),
      strobes: source.strobes.filter((clip) => clip.start < end && clip.start + clip.duration > start)
        .map((clip) => ({ ...clip, id: uid(), start: Math.max(0, clip.start - start) })),
      effects: source.effects
        .filter((effect) => effect.start < end && effect.start + effect.duration > start)
        .map((effect) => ({ ...effect, id: uid(), start: Math.max(0, effect.start - start) })),
    });
  }

  function pasteSelection() {
    const target = tracks[selectedFixtureId];
    if (!clipboard || !target) return;
    updateTrack(selectedFixtureId, {
      curve: clipboard.curve,
      points: [...target.points, ...clipboard.points.map((point) => ({ ...point, time: point.time + playhead }))]
        .filter((point) => point.time <= duration).sort((a, b) => a.time - b.time),
      colors: rippleColors(
        [...target.colors, ...clipboard.colors.map((clip) => ({ ...clip, id: uid(), start: clip.start + playhead }))],
        duration,
      ),
      colorTransitions: [
        ...target.colorTransitions,
        ...clipboard.colorTransitions.map((transition) => ({
          ...transition,
          id: uid(),
          start: transition.start + playhead,
        })),
      ],
      strobes: [...target.strobes, ...clipboard.strobes.map((clip) => ({ ...clip, id: uid(), start: clip.start + playhead }))],
      effects: [...target.effects, ...clipboard.effects.map((effect) => ({ ...effect, id: uid(), start: effect.start + playhead }))],
    });
  }

  function deleteSelection() {
    if (!selections.length) return;
    selections.forEach((selection) => {
      const source = tracks[selection.fixtureId];
      if (!source) return;
      const start = Math.min(selection.start, selection.end);
      const end = Math.max(selection.start, selection.end);
      updateTrack(selection.fixtureId, {
        ...source,
        points: source.points.filter((point) => point.time < start || point.time > end),
        colors: source.colors.filter(
          (clip) => clip.start >= end || clip.start + clip.duration <= start,
        ),
        colorTransitions: source.colorTransitions.filter(
          (transition) =>
            transition.start >= end ||
            transition.start + transition.duration <= start,
        ),
        strobes: source.strobes.filter(
          (clip) => clip.start >= end || clip.start + clip.duration <= start,
        ),
        effects: source.effects.filter(
          (effect) => effect.start >= end || effect.start + effect.duration <= start,
        ),
      });
    });
    setSelections([]);
  }

  function applyIntensityEffect(effect: EffectType) {
    openCreateEffectDialog(effect);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (playing) {
      if (transportLockEnabled && !stopArmed) {
        setStopArmed(true);
        return;
      }
      audio?.pause();
      setPlaying(false);
      setStopArmed(false);
      return;
    }
    if (audio?.src) {
      audio.currentTime = playhead;
      audio.volume = volume;
      audio.muted = false;
      try {
        await audio.play();
      } catch {
        setPlaying(false);
        setStopArmed(false);
        return;
      }
    }
    setStopArmed(false);
    setPlaying(true);
  }

  async function loadAudio(file: File) {
    setAudioName(file.name);
    setScrollPosition(0);
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = URL.createObjectURL(file);
    if (audioRef.current) {
      audioRef.current.src = audioUrlRef.current;
      audioRef.current.volume = volume;
      audioRef.current.muted = false;
      audioRef.current.load();
    }
    onAudioSourceChange({ name: file.name, url: audioUrlRef.current, file });
    try {
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      setDuration(Math.max(10, Math.ceil(buffer.duration)));
      const data = buffer.getChannelData(0);
      const bucketSize = Math.max(1, Math.floor(data.length / 400));
      setWaveform(Array.from({ length: 400 }, (_, bucket) => {
        let peak = 0;
        for (let index = bucket * bucketSize; index < Math.min(data.length, (bucket + 1) * bucketSize); index += 1) {
          peak = Math.max(peak, Math.abs(data[index]));
        }
        return Math.max(0.04, peak);
      }));
      await context.close();
    } catch {
      setAudioName(`${file.name} (preview unavailable)`);
    }
  }

  function setTimeAt(clientX: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const time =
      (clientX - bounds.left + viewport.scrollLeft - LABEL_WIDTH) /
      timelineScale;
    const next = Math.min(duration, snap(time, grid));
    setPlayhead(next);
    if (audioRef.current?.src) audioRef.current.currentTime = next;
  }

  function setZoomAroundClientX(nextZoom: number, clientX: number) {
    const viewport = viewportRef.current;
    if (!viewport) {
      setZoom(nextZoom);
      return;
    }

    const boundedZoom = Math.min(240, Math.max(25, nextZoom));
    const bounds = viewport.getBoundingClientRect();
    const pointerTime =
      (clientX - bounds.left + viewport.scrollLeft - LABEL_WIDTH) / timelineScale;

    setZoom(boundedZoom);

    requestAnimationFrame(() => {
      const updatedScale = Math.max(
        boundedZoom,
        Math.max(1, viewport.clientWidth - LABEL_WIDTH) / Math.max(1, duration),
      );
      const targetScroll =
        LABEL_WIDTH + Math.max(0, pointerTime) * updatedScale - (clientX - bounds.left);
      const maximumScroll = Math.max(
        0,
        LABEL_WIDTH + duration * updatedScale - viewport.clientWidth,
      );
      const nextScroll = Math.min(maximumScroll, Math.max(0, targetScroll));
      viewport.scrollLeft = nextScroll;
      setScrollPosition(nextScroll);
    });
  }

  function handleTimelineWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      setZoomAroundClientX(zoom - event.deltaY * 0.12, event.clientX);
      return;
    }
    if (!event.ctrlKey || !viewportRef.current) return;
    event.preventDefault();
    viewportRef.current.scrollLeft += event.deltaY || event.deltaX;
  }

  function handleViewportScroll(event: React.UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget;
    const maximumScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    // WebKit can report negative or beyond-the-end scroll offsets during its
    // rubber-band animation. Keep the fixed fixture-name pane pinned to the
    // real scrollable range instead of letting it follow that overscroll.
    const nextScroll = Math.min(
      maximumScroll,
      Math.max(0, viewport.scrollLeft),
    );
    event.currentTarget.style.setProperty("--track-scroll", `${nextScroll}px`);
    pendingScrollRef.current = nextScroll;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollPosition(pendingScrollRef.current);
    });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const primaryModifier = event.ctrlKey || event.metaKey;
      const target = event.target;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (event.code === "Space" && !isEditable) {
        if (transportLockEnabled) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        void togglePlayback();
      }
      if (primaryModifier && key === "c" && !isEditable) {
        event.preventDefault();
        copySelection();
      }
      if (primaryModifier && key === "v" && !isEditable) {
        event.preventDefault();
        pasteSelection();
      }
      const wantsRedo =
        primaryModifier && (key === "y" || (key === "z" && event.shiftKey));
      const wantsUndo = primaryModifier && key === "z" && !event.shiftKey;
      if (wantsUndo || wantsRedo) {
        if (
          isEditable &&
          !(
            target instanceof HTMLTextAreaElement &&
            target.classList.contains("cueAssistantInput") &&
            target.value.length === 0
          )
        ) {
          return;
        }
        event.preventDefault();
        if (wantsRedo ? redoLastChange() : undoLastChange()) {
          addHistoryMessage(wantsRedo ? "Redid" : "Undid");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [transportLockEnabled, selections, clipboard, selectedFixtureId, playhead, playing, duration, tracks]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!itemContextMenu) return;
    const closeMenu = () => setItemContextMenu(null);
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [itemContextMenu]);

  const orderedFixtures = fixtureOrder
    .map((id) => fixtures.find((fixture) => fixture.id === id))
    .filter((fixture): fixture is PatchedFixture => Boolean(fixture));
  const orderedTrackItems: Array<
    { type: "fixture"; fixture: PatchedFixture } | { type: "group"; group: FixtureGroup }
  > = fixtureOrder.reduce<Array<
    { type: "fixture"; fixture: PatchedFixture } | { type: "group"; group: FixtureGroup }
  >>((items, fixtureId) => {
    const fixture = fixtures.find((item) => item.id === fixtureId);
    if (!fixture) return items;
    const group = fixtureGroupByFixtureId.get(fixture.id);
    if (!group) {
      items.push({ type: "fixture", fixture });
      return items;
    }
    const firstMember = fixtureOrder.find((id) => group.fixtureIds.includes(id));
    if (firstMember === fixture.id) {
      items.push({ type: "group", group });
    }
    return items;
  }, []);

  return (
    <main
      ref={rootRef}
      className={`timelinePage timelineV2 ${transportLockEnabled ? "transportLockedScreen" : ""}`}
    >
      <div className="timelineToolbar">
        <div>
          <p className="eyebrow">SHOW PROGRAMMING</p>
          <h1>Timeline Editor</h1>
          <div className="stageTabs">
            {stages.map((stage) => (
              <div
                key={stage.id}
                className={`stageTab ${stage.id === activeStageId ? "stageTabActive" : ""}`}
              >
                <button onClick={() => onSelectStage(stage.id)}>{stage.name}</button>
                <span
                  className="stageTabEdit"
                  onClick={() => onRenameStage(stage.id)}
                  title="Rename stage"
                >
                  ✎
                </span>
                <span
                  className="stageTabRemove"
                  onClick={() => onRemoveStage(stage.id)}
                  title="Remove stage"
                >
                  ×
                </span>
              </div>
            ))}
            <button className="addStageButton" onClick={onAddStage}>+ Stage</button>
          </div>
        </div>
        <div className="toolbarCenter">
          <button
            className={`transportLockButton ${transportLockEnabled ? "lockActive" : ""}`}
            onClick={() => {
              setTransportLockEnabled((value) => !value);
              setStopArmed(false);
            }}
            title="Require a double press on play to stop while the show is running"
          >
            Lock
          </button>
          <div className="transportControls">
            <button onClick={() => setPlayhead(0)}>|◀</button>
            <button
              className={`playButton ${stopArmed ? "stopArmed" : ""}`}
              onClick={() => void togglePlayback()}
              onDoubleClick={() => {
                if (!transportLockEnabled) return;
                setTransportLockEnabled(false);
                setStopArmed(false);
              }}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <button onClick={() => setPlayhead(Math.min(duration, playhead + 5))}>▶|</button>
            <strong>{clock(playhead)}</strong>
            <label className="volumeControl" title="Volume">🔊
              <input type="range" min="0" max="1" step="0.01" value={volume}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  onVolumeChange(next);
                  if (audioRef.current) audioRef.current.volume = next;
                }} />
            </label>
          </div>
          <label className="zoomControl toolbarZoomControl"><span>Horizontal zoom</span>
            <input type="range" min="25" max="240" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
            <strong>{Math.round((zoom / 80) * 100)}%</strong>
          </label>
        </div>
        <div className="timelineActions">
          <button className={selectionMode ? "toolActive" : ""} onClick={() => setSelectionMode(!selectionMode)}>Select range</button>
          <button disabled={!selections.length} onClick={copySelection}>Copy</button>
          <button disabled={!clipboard || !selectedFixtureId} onClick={pasteSelection}>Paste at marker</button>
          <label className="audioPicker"><span>{audioName || "Choose audio"}</span>
            <input type="file" accept="audio/*" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadAudio(file);
            }} />
          </label>
        </div>
      </div>

      {transportLockEnabled ? <div className="transportLockOverlay" /> : null}

      <div className="editorWorkspace">
        <aside className="effectLibrary">
          <div className="libraryTitle"><span>LIBRARY</span><button>+</button></div>
          <button className="librarySection active">Fixtures</button>
          <div className="fixtureScroller">
            {orderedFixtures.map((fixture) => <button key={fixture.id}
              className={selectedFixtureIds.includes(fixture.id) ? "selected" : ""}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey) {
                  setSelectedFixtureIds((previous) =>
                    previous.includes(fixture.id)
                      ? previous.filter((id) => id !== fixture.id)
                      : [...previous, fixture.id],
                  );
                  setSelectedFixtureId(fixture.id);
                  return;
                }
                selectSingleFixture(fixture.id);
              }}>
              <i />{fixture.name}
            </button>)}
          </div>
          <div className="groupActionRow">
            <button
              disabled={
                selectedFixtureIds.length < 2 ||
                selectedFixtureIds.some((fixtureId) => fixtureGroupByFixtureId.has(fixtureId))
              }
              onClick={createFixtureGroup}
            >
              Group
            </button>
            <button
              disabled={
                !selectedFixtureIds.some((fixtureId) => fixtureGroupByFixtureId.has(fixtureId)) &&
                !fixtureGroups.some((group) => group.id === selectedFixtureId)
              }
              onClick={ungroupSelectedFixtures}
            >
              Ungroup
            </button>
          </div>
          <button className="librarySection active">Effects</button>
          <div className="effectScroller">
            <button disabled={!selections.length} onClick={() => applyIntensityEffect("rise")}>
              Rise
            </button>
            <button disabled={!selections.length} onClick={() => applyIntensityEffect("fade")}>
              Fade
            </button>
            <button disabled={!selections.length} onClick={() => applyIntensityEffect("pulse")}>
              Pulse
            </button>
            <button disabled={!selections.length} onClick={() => applyIntensityEffect("random")}>
              Random
            </button>
            <button disabled={!selections.length} onClick={() => applyIntensityEffect("spline")}>
              Spline curve
            </button>
          </div>
          <button className="librarySection">Presets <small>SOON</small></button>
          <section className="cueAssistant" aria-label="AI cue assistant">
            <div className="cueAssistantHeader">
              <span>AI CUE ASSISTANT</span>
              <small>LOCAL</small>
            </div>
            <div className="cueAssistantMessages" aria-live="polite">
              {cueAssistantMessages.slice(-4).map((message) => (
                <p
                  key={message.id}
                  className={`${message.role} ${message.tone ?? ""}`}
                >
                  {message.text}
                </p>
              ))}
            </div>
            <textarea
              className="cueAssistantInput"
              value={cueAssistantInput}
              onChange={(event) => setCueAssistantInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                submitCueAssistantCommand();
              }}
              placeholder="Make the front lights blue at 10s..."
              rows={3}
            />
            <button
              className="cueAssistantSend"
              disabled={!cueAssistantInput.trim()}
              onClick={submitCueAssistantCommand}
            >
              Create cue
            </button>
          </section>
        </aside>

        <section className="editorMain">
          <div className="editorOptions">
            <label>Grid
              <select value={grid} onChange={(event) => setGrid(Number(event.target.value))}>
                <option value={0.25}>¼ second</option><option value={0.5}>½ second</option>
                <option value={1}>1 second</option><option value={2}>2 seconds</option>
              </select>
            </label>
          </div>
          <div ref={viewportRef} className="timelineViewport"
            onScroll={handleViewportScroll}
            onWheelCapture={handleTimelineWheel}
            onPointerDownCapture={(event) => {
              const target = event.target as HTMLElement;
              const primaryModifier = event.ctrlKey || event.metaKey;
              const isGraphOrControl = Boolean(
                target.closest(
                  "button, input, select, textarea, .colorBlock, .strobeClip, .effectRegion, .waypoint, .intensityPath, .curveBackdrop, .clipDragSurface, .resizeHandle",
                ),
              );
              if (
                primaryModifier &&
                event.button === 0 &&
                !selectionMode &&
                !isGraphOrControl
              ) {
                selectionGestureRef.current = true;
                event.currentTarget.dataset.selectionStartX = String(event.clientX);
                event.currentTarget.dataset.selectionStartY = String(event.clientY);
                event.currentTarget.setPointerCapture(event.pointerId);
                setSelections(
                  getSelectionsFromMarquee(
                    event.clientX,
                    event.clientY,
                    event.clientX,
                    event.clientY,
                  ),
                );
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (
                selectionGestureRef.current ||
                !selections.length ||
                selectionMode ||
                event.ctrlKey ||
                event.metaKey
              ) return;
              const viewport = viewportRef.current;
              if (!viewport) return;
              const bounds = viewport.getBoundingClientRect();
              const clickedTime =
                (event.clientX - bounds.left + viewport.scrollLeft - LABEL_WIDTH) /
                timelineScale;
              const clickedFixtureId = (event.target as HTMLElement)
                .closest<HTMLElement>("[data-fixture-id]")
                ?.dataset.fixtureId;
              const clickedSelection = selections.find(
                (selection) =>
                  selection.fixtureId === clickedFixtureId &&
                  clickedTime >= Math.min(selection.start, selection.end) &&
                  clickedTime <= Math.max(selection.start, selection.end),
              );

              if (!clickedSelection) {
                setSelections([]);
              }
            }}
            onPointerMoveCapture={(event) => {
              if (
                !selectionGestureRef.current ||
                !event.currentTarget.hasPointerCapture(event.pointerId)
              ) {
                return;
              }
              setSelections(
                getSelectionsFromMarquee(
                  Number(
                    event.currentTarget.dataset.selectionStartX ??
                      event.clientX,
                  ),
                  Number(
                    event.currentTarget.dataset.selectionStartY ??
                      event.clientY,
                  ),
                  event.clientX,
                  event.clientY,
                ),
              );
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerUpCapture={(event) => {
              if (
                !selectionGestureRef.current ||
                !event.currentTarget.hasPointerCapture(event.pointerId)
              ) {
                return;
              }
              selectionGestureRef.current = false;
              event.currentTarget.releasePointerCapture(event.pointerId);
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerCancelCapture={(event) => {
              if (!selectionGestureRef.current) return;
              selectionGestureRef.current = false;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onWheel={handleTimelineWheel}
            onContextMenu={(event) => {
              event.preventDefault();
              setTimeAt(event.clientX);
              setContextMenu({ x: event.clientX, y: event.clientY });
            }}
            onDoubleClick={(event) => setTimeAt(event.clientX)}>
            <div className="timelineCanvas" style={{ width: LABEL_WIDTH + contentWidth }}>
              <TimeRuler duration={duration} zoom={timelineScale} width={contentWidth} />
              <div className="playhead draggablePlayhead" style={{ left: LABEL_WIDTH + playhead * timelineScale }}
                onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) setTimeAt(event.clientX);
                }}><span>{clock(playhead)}</span></div>
              <BeatgridLane
                points={beatgrid}
                playhead={playhead}
                zoom={timelineScale}
                width={contentWidth}
                duration={duration}
                onChange={setBeatgrid}
              />
              <div ref={fixtureTracksRef} className="fixtureTracks">
                {selectionMode ? (
                  <div
                    className="multiFixtureSelectionOverlay"
                    onPointerDown={(event) => {
                      selectionGestureRef.current = true;
                      const overlay = event.currentTarget;
                      overlay.dataset.startX = String(event.clientX);
                      overlay.dataset.startY = String(event.clientY);
                      overlay.setPointerCapture(event.pointerId);
                      setSelections(
                        getSelectionsFromMarquee(
                          event.clientX,
                          event.clientY,
                          event.clientX,
                          event.clientY,
                        ),
                      );
                    }}
                    onPointerMove={(event) => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      setSelections(
                        getSelectionsFromMarquee(
                          Number(event.currentTarget.dataset.startX ?? event.clientX),
                          Number(event.currentTarget.dataset.startY ?? event.clientY),
                          event.clientX,
                          event.clientY,
                        ),
                      );
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      requestAnimationFrame(() => {
                        selectionGestureRef.current = false;
                      });
                    }}
                    onPointerCancel={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      requestAnimationFrame(() => {
                        selectionGestureRef.current = false;
                      });
                    }}
                  />
                ) : null}
                {orderedTrackItems.map((item) => item.type === "fixture" ? (
                  <FixtureTrack key={item.fixture.id} fixture={item.fixture}
                    data={tracks[item.fixture.id]} zoom={timelineScale} grid={grid} duration={duration}
                    beatTimes={beatTimes}
                    width={contentWidth} selected={selectedFixtureId === item.fixture.id}
                    selection={selections.find((selection) => selection.fixtureId === item.fixture.id) ?? null}
                    onPreviewColorChange={onColorPreviewChange}
                    selectedEffectKey={selectedEffectKey}
                    selectedColorKey={selectedColorKey}
                    onSelectColorClip={setSelectedColorKey}
                    onRequestColorTransition={openColorTransitionEditor}
                    onSelectEffect={openEditEffectDialog}
                    onOpenItemContextMenu={setItemContextMenu}
                    onSelect={() => selectSingleFixture(item.fixture.id)}
                    onSelection={(nextSelection) => {
                      setSelections((previous) => {
                        const filtered = previous.filter(
                          (selection) => selection.fixtureId !== item.fixture.id,
                        );
                        return nextSelection ? [...filtered, nextSelection] : filtered;
                      });
                      if (nextSelection) {
                        selectSingleFixture(nextSelection.fixtureId);
                      }
                    }}
                    onChange={(data) => updateTrack(item.fixture.id, data)}
                    onMoveFixture={(draggedId, targetId) => {
                      setFixtureOrder((previous) => {
                        const withoutDragged = previous.filter((id) => id !== draggedId);
                        const targetIndex = withoutDragged.indexOf(targetId);
                        withoutDragged.splice(Math.max(0, targetIndex), 0, draggedId);
                        return withoutDragged;
                      });
                    }}
                    onPan={(delta) => { if (viewportRef.current) viewportRef.current.scrollLeft -= delta; }} />
                ) : (
                  <GroupedFixtureTrack
                    key={item.group.id}
                    group={item.group}
                    fixtures={item.group.fixtureIds
                      .map((fixtureId) => fixtures.find((fixture) => fixture.id === fixtureId))
                      .filter((fixture): fixture is PatchedFixture => Boolean(fixture))}
                    data={tracks[item.group.id]}
                    zoom={timelineScale}
                    grid={grid}
                    duration={duration}
                    width={contentWidth}
                    beatTimes={beatTimes}
                    selected={selectedFixtureId === item.group.id}
                    selectedChildFixtureId={selectedFixtureId}
                    expanded={expandedGroupIds.includes(item.group.id)}
                    selection={selections.find((selection) => selection.fixtureId === item.group.id) ?? null}
                    childSelections={selections}
                    childTracks={tracks}
                    onToggleExpanded={() =>
                      setExpandedGroupIds((previous) =>
                        previous.includes(item.group.id)
                          ? previous.filter((groupId) => groupId !== item.group.id)
                          : [...previous, item.group.id],
                      )
                    }
                    onPreviewColorChange={onColorPreviewChange}
                    selectedEffectKey={selectedEffectKey}
                    selectedColorKey={selectedColorKey}
                    onSelectColorClip={setSelectedColorKey}
                    onRequestColorTransition={openColorTransitionEditor}
                    onSelectEffect={openEditEffectDialog}
                    onOpenItemContextMenu={setItemContextMenu}
                    onSelect={() => selectFixtureGroup(item.group)}
                    onSelection={(nextSelection) => {
                      setSelections((previous) => {
                        const filtered = previous.filter(
                          (selection) => selection.fixtureId !== item.group.id,
                        );
                        return nextSelection ? [...filtered, nextSelection] : filtered;
                      });
                      if (nextSelection) selectFixtureGroup(item.group);
                    }}
                    onChildSelect={(fixtureId) => selectSingleFixture(fixtureId)}
                    onChildSelection={(fixtureId, nextSelection) => {
                      setSelections((previous) => {
                        const filtered = previous.filter((selection) => selection.fixtureId !== fixtureId);
                        return nextSelection ? [...filtered, nextSelection] : filtered;
                      });
                      if (nextSelection) selectSingleFixture(fixtureId);
                    }}
                    onChange={(data) => updateTrack(item.group.id, data)}
                    onChildChange={(fixtureId, data) => updateTrack(fixtureId, data)}
                    onMoveFixture={(draggedId, targetId) => {
                      setFixtureOrder((previous) => {
                        const withoutDragged = previous.filter((id) => id !== draggedId);
                        const targetIndex = withoutDragged.indexOf(targetId);
                        withoutDragged.splice(Math.max(0, targetIndex), 0, draggedId);
                        return withoutDragged;
                      });
                    }}
                    onPan={(delta) => { if (viewportRef.current) viewportRef.current.scrollLeft -= delta; }}
                  />
                ))}
              </div>
            </div>
          </div>
          <label className="horizontalPan">
            <span>PAN</span>
            <input type="range" min="0"
              max={Math.max(0, contentWidth - (viewportRef.current?.clientWidth ?? 0) + LABEL_WIDTH)}
              value={scrollPosition}
              onChange={(event) => {
                const value = Number(event.target.value);
                setScrollPosition(value);
                if (viewportRef.current) viewportRef.current.scrollLeft = value;
              }} />
          </label>
          <Waveform
            samples={waveform}
            name={audioName || "No audio selected"}
            width={contentWidth}
            visibleWidth={Math.max(0, viewportWidth - LABEL_WIDTH)}
            scroll={scrollPosition}
          />
        </section>
      </div>
      <audio ref={audioRef} preload="auto" />
      {contextMenu && !itemContextMenu && (
        <div
          className="timelineContextMenu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            disabled={!undoStackRef.current.length}
            onClick={() => {
              if (undoLastChange()) addHistoryMessage("Undid");
              setContextMenu(null);
            }}
          >
            Undo <small>Ctrl+Z</small>
          </button>
          <button
            disabled={!redoStackRef.current.length}
            onClick={() => {
              if (redoLastChange()) addHistoryMessage("Redid");
              setContextMenu(null);
            }}
          >
            Redo <small>Ctrl+Y</small>
          </button>
          <button
            disabled={!transitionClipboard || !selectedFixtureId}
            onClick={pasteTransitionAtPlayhead}
          >
            Paste transition
          </button>
          <hr />
          <button disabled={!selections.length} onClick={() => { copySelection(); setContextMenu(null); }}>
            Copy
          </button>
          <button disabled={!clipboard || !selectedFixtureId} onClick={() => { pasteSelection(); setContextMenu(null); }}>
            Paste
          </button>
          <button disabled={!selections.length} onClick={() => { deleteSelection(); setContextMenu(null); }}>
            Delete
          </button>
        </div>
      )}
      {itemContextMenu ? (
        <div
          className="clipContextMenu"
          style={{ left: itemContextMenu.x, top: itemContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            disabled={!undoStackRef.current.length}
            onClick={() => {
              if (undoLastChange()) addHistoryMessage("Undid");
              setItemContextMenu(null);
            }}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={!redoStackRef.current.length}
            onClick={() => {
              if (redoLastChange()) addHistoryMessage("Redid");
              setItemContextMenu(null);
            }}
          >
            Redo
          </button>
          {itemContextMenu.kind === "colorTransition" ? (
            <button type="button" onClick={copyTransitionFromContextMenu}>
              Copy transition
            </button>
          ) : null}
          <button
            type="button"
            disabled={!transitionClipboard}
            onClick={pasteTransitionAtPlayhead}
          >
            Paste transition
          </button>
          <hr />
          <button type="button" onClick={deleteItemFromContextMenu}>
            Delete
          </button>
        </div>
      ) : null}
      {colorTransitionEditor ? (
        <div
          className="effectDialogBackdrop"
          onPointerDown={() => setColorTransitionEditor(null)}
        >
          <div
            className="effectDialog colorTransitionDialog"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="effectDialogHeader">
              <div>
                <strong>Add color transition</strong>
                <span>Blend smoothly between the two touching colors.</span>
              </div>
              <button type="button" onClick={() => setColorTransitionEditor(null)}>
                Ã—
              </button>
            </div>
            <label>
              Transition duration
              <div className="transitionDurationInput">
                <input
                  type="number"
                  min="0.1"
                  max="30"
                  step="0.1"
                  value={colorTransitionEditor.duration}
                  onChange={(event) =>
                    setColorTransitionEditor((previous) =>
                      previous
                        ? {
                            ...previous,
                            duration: Math.max(0.1, Number(event.target.value)),
                          }
                        : previous
                    )
                  }
                />
                <span>seconds</span>
              </div>
            </label>
            <div className="effectDialogActions">
              <span />
              <div>
                <button type="button" onClick={() => setColorTransitionEditor(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primaryButton"
                  onClick={submitColorTransition}
                >
                  Add transition
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {effectEditor ? (
        <div className="effectDialogBackdrop" onPointerDown={() => setEffectEditor(null)}>
          <div className="effectDialog" onPointerDown={(event) => event.stopPropagation()}>
            <div className="effectDialogHeader">
              <div>
                <strong>{effectEditor.mode === "create" ? `Add ${effectEditor.type} effect` : `Edit ${effectEditor.type} effect`}</strong>
                <span>
                  {effectEditor.mode === "create"
                    ? `${effectEditor.targetSelections.length} selected region${effectEditor.targetSelections.length === 1 ? "" : "s"}`
                    : "Quick edit intensity effect settings"}
                </span>
              </div>
              <button type="button" onClick={() => setEffectEditor(null)}>×</button>
            </div>
            <div className="effectDialogGrid">
              {effectEditor.type === "pulse" ? (
                <>
                  <label>
                    Active length
                    <input
                      type="number"
                      min="0.05"
                      step="0.05"
                      value={effectEditor.values.activeLength}
                      onChange={(event) =>
                        setEffectEditor((previous) => previous ? {
                          ...previous,
                          values: { ...previous.values, activeLength: Number(event.target.value) },
                        } : previous)
                      }
                    />
                  </label>
                  <label>
                    Spacing length
                    <input
                      type="number"
                      min="0.05"
                      step="0.05"
                      value={effectEditor.values.spacingLength}
                      onChange={(event) =>
                        setEffectEditor((previous) => previous ? {
                          ...previous,
                          values: { ...previous.values, spacingLength: Number(event.target.value) },
                        } : previous)
                      }
                    />
                  </label>
                  <label>
                    Intensity
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={effectEditor.values.intensity}
                      onChange={(event) =>
                        setEffectEditor((previous) => previous ? {
                          ...previous,
                          values: { ...previous.values, intensity: Number(event.target.value) },
                        } : previous)
                      }
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    {effectEditor.type === "fade" ? "Max fade" : "Max rise"}
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={effectEditor.values.maxIntensity}
                      onChange={(event) =>
                        setEffectEditor((previous) => previous ? {
                          ...previous,
                          values: { ...previous.values, maxIntensity: Number(event.target.value) },
                        } : previous)
                      }
                    />
                  </label>
                  <label>
                    {effectEditor.type === "fade" ? "Min fade" : "Min rise"}
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={effectEditor.values.minIntensity}
                      onChange={(event) =>
                        setEffectEditor((previous) => previous ? {
                          ...previous,
                          values: { ...previous.values, minIntensity: Number(event.target.value) },
                        } : previous)
                      }
                    />
                  </label>
                  <label className="effectDialogToggleField">
                    Length mode
                    <div className="effectDialogModeToggle" role="group" aria-label="Length mode">
                      <button
                        type="button"
                        className={effectEditor.values.lengthMode === "bars" ? "selected" : ""}
                        onClick={() =>
                          setEffectEditor((previous) => previous ? {
                            ...previous,
                            values: { ...previous.values, lengthMode: "bars" },
                          } : previous)
                        }
                      >
                        Bars
                      </button>
                      <button
                        type="button"
                        className={effectEditor.values.lengthMode === "time" ? "selected" : ""}
                        onClick={() =>
                          setEffectEditor((previous) => previous ? {
                            ...previous,
                            values: { ...previous.values, lengthMode: "time" },
                          } : previous)
                        }
                      >
                        Time
                      </button>
                    </div>
                  </label>
                  <label>
                    {effectEditor.values.lengthMode === "bars" ? "Length (bars)" : "Length (seconds)"}
                    <input
                      type="number"
                      min="0.05"
                      step="0.05"
                      value={effectEditor.values.lengthMode === "bars" ? effectEditor.values.lengthBars : effectEditor.values.length}
                      onChange={(event) =>
                        setEffectEditor((previous) => previous ? {
                          ...previous,
                          values: previous.values.lengthMode === "bars"
                            ? { ...previous.values, lengthBars: Number(event.target.value) }
                            : { ...previous.values, length: Number(event.target.value) },
                        } : previous)
                      }
                    />
                  </label>
                </>
              )}
            </div>
            <div className="effectDialogActions">
              {effectEditor.mode === "edit" ? (
                <button type="button" className="dangerButton" onClick={deleteEditingEffect}>Delete</button>
              ) : <span />}
              <div>
                <button type="button" onClick={() => setEffectEditor(null)}>Cancel</button>
                <button type="button" className="primaryButton" onClick={submitEffectEditor}>
                  {effectEditor.mode === "create" ? "Add effect" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function TimeRuler({ duration, zoom, width }: { duration: number; zoom: number; width: number }) {
  return <div className="timeRuler" style={{ left: LABEL_WIDTH, width }}>
    {Array.from({ length: Math.floor(duration) + 1 }, (_, seconds) => <span key={seconds}
      className={seconds % 5 === 0 ? "majorTick" : ""} style={{ left: seconds * zoom }}>
      {seconds % 5 === 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : ""}
    </span>)}
  </div>;
}

function FixtureTrack({ fixture, data, zoom, grid, duration, width, selected, selection,
  beatTimes, onSelect, onSelection, onChange, onMoveFixture, onPan, onPreviewColorChange, selectedEffectKey, selectedColorKey, onSelectColorClip, onRequestColorTransition, onSelectEffect, onOpenItemContextMenu }: {
  fixture: PatchedFixture; data?: TrackData; zoom: number; grid: number; duration: number; width: number;
  beatTimes: number[];
  selected: boolean; selection: Selection | null; onSelect: () => void;
  onSelection: (selection: Selection | null) => void; onChange: (data: TrackData) => void;
  onMoveFixture: (draggedId: string, targetId: string) => void; onPan: (delta: number) => void;
  onPreviewColorChange: (color: string | null) => void;
  selectedEffectKey: string | null;
  selectedColorKey: string | null;
  onSelectColorClip: (key: string) => void;
  onRequestColorTransition: (fixtureId: string, leftClipId: string, rightClipId: string) => void;
  onSelectEffect: (fixtureId: string, effect: IntensityEffect) => void;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [reordering, setReordering] = useState(false);
  const headerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  if (!data) return null;
  return <section
    data-fixture-id={fixture.id}
    className={`fixtureTrack ${selected ? "selectedTrack" : ""}`}
    onPointerDownCapture={onSelect}
  >
    <button className={`trackHeader ${reordering ? "isReordering" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        headerDragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          dragging: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = headerDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) {
          return;
        }
        const movedX = event.clientX - drag.startX;
        const movedY = event.clientY - drag.startY;
        if (!drag.dragging && Math.hypot(movedX, movedY) > 6) {
          drag.dragging = true;
          setReordering(true);
        }
        if (!drag.dragging) return;
        event.preventDefault();
        const targetFixtureId = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-fixture-id]")
          ?.dataset.fixtureId;
        if (targetFixtureId && targetFixtureId !== fixture.id) {
          onMoveFixture(fixture.id, targetFixtureId);
        }
      }}
      onPointerUp={(event) => {
        const drag = headerDragRef.current;
        if (
          drag &&
          drag.pointerId === event.pointerId &&
          event.currentTarget.hasPointerCapture(event.pointerId)
        ) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const wasDragging = Boolean(drag?.dragging);
        headerDragRef.current = null;
        setReordering(false);
        if (!wasDragging) {
          onSelect();
          setCollapsed(!collapsed);
        }
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        headerDragRef.current = null;
        setReordering(false);
      }}
      title={fixture.name}
    >
      <span className="collapseIcon">{collapsed ? "›" : "⌄"}</span>
      <span className="trackHeaderMeta">
        <strong title={fixture.name}>{fixture.name}</strong>
        <small title={getFixtureMode(fixture.modeId).name}>
          DMX {fixture.startAddress} · {getFixtureMode(fixture.modeId).name}
        </small>
      </span>
      <span className="trackState">{selected ? "SELECTED" : ""}</span>
    </button>
    {!collapsed && <div className="trackBody" style={{ marginLeft: LABEL_WIDTH, width }}>
      <CurveLane
        fixtureId={fixture.id}
        data={data}
        zoom={zoom}
        grid={grid}
        duration={duration}
        width={width}
        beatTimes={beatTimes}
        selectedEffectKey={selected ? selectedEffectKey : null}
        onSelectEffect={onSelectEffect}
        onOpenItemContextMenu={onOpenItemContextMenu}
        onChange={onChange}
        onPan={onPan}
      />
      <div className="parameterDivider"><span>FIXTURE PARAMETERS</span></div>
      <ColorLane clips={data.colors} transitions={data.colorTransitions} zoom={zoom} grid={grid} duration={duration} width={width} beatTimes={beatTimes}
        onChange={(colors, colorTransitions) => onChange({ ...data, colors, colorTransitions })}
        onPreviewColorChange={onPreviewColorChange}
        fixtureId={fixture.id}
        selectedColorKey={selectedColorKey}
        onSelectColorClip={onSelectColorClip}
        onRequestColorTransition={onRequestColorTransition}
        onOpenItemContextMenu={onOpenItemContextMenu} />
      <StrobeLane fixtureId={fixture.id} clips={data.strobes} zoom={zoom} grid={grid} duration={duration} width={width} beatTimes={beatTimes}
        onChange={(strobes) => onChange({ ...data, strobes })}
        onOpenItemContextMenu={onOpenItemContextMenu} />
      {selection && (
        <SelectionLayer
          fixtureId={fixture.id}
          zoom={zoom}
          selection={selection}
          active={false}
          onChange={onSelection}
        />
      )}
    </div>}
  </section>;
}

function GroupedFixtureTrack({
  group,
  fixtures,
  data,
  zoom,
  grid,
  duration,
  width,
  beatTimes,
  selected,
  selectedChildFixtureId,
  expanded,
  selection,
  childSelections,
  childTracks,
  onToggleExpanded,
  onPreviewColorChange,
  selectedEffectKey,
  selectedColorKey,
  onSelectColorClip,
  onRequestColorTransition,
  onSelectEffect,
  onOpenItemContextMenu,
  onSelect,
  onSelection,
  onChildSelect,
  onChildSelection,
  onChange,
  onChildChange,
  onMoveFixture,
  onPan,
}: {
  group: FixtureGroup;
  fixtures: PatchedFixture[];
  data?: TrackData;
  zoom: number;
  grid: number;
  duration: number;
  width: number;
  beatTimes: number[];
  selected: boolean;
  selectedChildFixtureId: string;
  expanded: boolean;
  selection: Selection | null;
  childSelections: Selection[];
  childTracks: Record<string, TrackData>;
  onToggleExpanded: () => void;
  onPreviewColorChange: (color: string | null) => void;
  selectedEffectKey: string | null;
  selectedColorKey: string | null;
  onSelectColorClip: (key: string) => void;
  onRequestColorTransition: (fixtureId: string, leftClipId: string, rightClipId: string) => void;
  onSelectEffect: (fixtureId: string, effect: IntensityEffect) => void;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
  onSelect: () => void;
  onSelection: (selection: Selection | null) => void;
  onChildSelect: (fixtureId: string) => void;
  onChildSelection: (fixtureId: string, selection: Selection | null) => void;
  onChange: (data: TrackData) => void;
  onChildChange: (fixtureId: string, data: TrackData) => void;
  onMoveFixture: (draggedId: string, targetId: string) => void;
  onPan: (delta: number) => void;
}) {
  if (!data) return null;
  const leadFixture = fixtures[0];
  return (
    <section
      data-fixture-id={group.id}
      className={`fixtureTrack groupedFixtureTrack ${selected ? "selectedTrack" : ""}`}
      onPointerDownCapture={onSelect}
    >
      <button className="trackHeader groupTrackHeader" onClick={onSelect} title={group.name}>
        <span className="collapseIcon">{expanded ? "⌄" : "›"}</span>
        <span className="trackHeaderMeta">
          <strong title={group.name}>{group.name}</strong>
          <small title={leadFixture ? getFixtureMode(leadFixture.modeId).name : "Grouped fixtures"}>
            {fixtures.length} fixtures · Shared timeline
          </small>
        </span>
        <span className="trackState">{selected ? "GROUPED" : ""}</span>
      </button>
      <div className="trackBody" style={{ marginLeft: LABEL_WIDTH, width }}>
        <CurveLane
          fixtureId={group.id}
          data={data}
          zoom={zoom}
          grid={grid}
          duration={duration}
          width={width}
          beatTimes={beatTimes}
          selectedEffectKey={selected ? selectedEffectKey : null}
          onSelectEffect={onSelectEffect}
          onOpenItemContextMenu={onOpenItemContextMenu}
          onChange={onChange}
          onPan={onPan}
        />
        <div className="parameterDivider"><span>FIXTURE PARAMETERS</span></div>
        <ColorLane clips={data.colors} transitions={data.colorTransitions} zoom={zoom} grid={grid} duration={duration} width={width} beatTimes={beatTimes}
          onChange={(colors, colorTransitions) => onChange({ ...data, colors, colorTransitions })}
          onPreviewColorChange={onPreviewColorChange}
          fixtureId={group.id}
          selectedColorKey={selectedColorKey}
          onSelectColorClip={onSelectColorClip}
          onRequestColorTransition={onRequestColorTransition}
          onOpenItemContextMenu={onOpenItemContextMenu} />
        <StrobeLane fixtureId={group.id} clips={data.strobes} zoom={zoom} grid={grid} duration={duration} width={width} beatTimes={beatTimes}
          onChange={(strobes) => onChange({ ...data, strobes })}
          onOpenItemContextMenu={onOpenItemContextMenu} />
        {selection ? (
          <SelectionLayer
            fixtureId={group.id}
            zoom={zoom}
            selection={selection}
            active={false}
            onChange={onSelection}
          />
        ) : null}
      </div>
      <button className="groupChildrenToggle" onClick={onToggleExpanded}>
        {expanded ? "Hide individual fixtures" : "Show individual fixtures"}
      </button>
      {expanded ? (
        <div className="groupChildren">
          {fixtures.map((fixture) => (
            <FixtureTrack
              key={fixture.id}
              fixture={fixture}
              data={childTracks[fixture.id]}
              zoom={zoom}
              grid={grid}
              duration={duration}
              width={width}
              beatTimes={beatTimes}
              selected={selectedChildFixtureId === fixture.id}
              selection={childSelections.find((item) => item.fixtureId === fixture.id) ?? null}
              onPreviewColorChange={onPreviewColorChange}
              selectedEffectKey={selectedEffectKey}
              selectedColorKey={selectedColorKey}
              onSelectColorClip={onSelectColorClip}
              onRequestColorTransition={onRequestColorTransition}
              onSelectEffect={onSelectEffect}
              onOpenItemContextMenu={onOpenItemContextMenu}
              onSelect={() => onChildSelect(fixture.id)}
              onSelection={(nextSelection) => onChildSelection(fixture.id, nextSelection)}
              onChange={(nextData) => onChildChange(fixture.id, nextData)}
              onMoveFixture={onMoveFixture}
              onPan={onPan}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CurveLane({ fixtureId, data, zoom, grid, duration, width, beatTimes, selectedEffectKey, onSelectEffect, onOpenItemContextMenu, onChange, onPan }: {
  fixtureId: string;
  data: TrackData; zoom: number; grid: number; duration: number; width: number;
  beatTimes: number[];
  selectedEffectKey: string | null;
  onSelectEffect: (fixtureId: string, effect: IntensityEffect) => void;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
  onChange: (data: TrackData) => void; onPan: (delta: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const waypointDrag = useRef<{ point: Point; timeOffset: number } | null>(
    null,
  );
  const segmentDrag = useRef<{
    orientation: "horizontal" | "vertical";
    leftIndex: number;
    rightIndex: number;
    startX: number;
    startY: number;
    startTime: number;
    startValue: number;
  } | null>(null);
  const sorted = [...data.points].sort((a, b) => a.time - b.time);
  const activeSplineEffect = selectedEffectKey
    ? data.effects.find(
        (effect) => `${fixtureId}:${effect.id}` === selectedEffectKey && effect.type === "spline",
      )
    : undefined;
  const splineRegions = data.effects
    .filter((effect): effect is SplineEffect => effect.type === "spline")
    .map((effect) => ({ start: effect.start, end: effect.start + effect.duration }));
  const path = buildIntensityPath(sorted, zoom, data.curve === "smooth", splineRegions);
  const toPoint = (clientX: number, clientY: number) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { time: Math.min(duration, snap((clientX - bounds.left) / zoom, grid)),
      value: Math.min(1, Math.max(0, 1 - (clientY - bounds.top) / bounds.height)) };
  };
  const isWithinActiveSpline = (time: number) =>
    !!activeSplineEffect &&
    time >= activeSplineEffect.start - 0.0001 &&
    time <= activeSplineEffect.start + activeSplineEffect.duration + 0.0001;
  const clampToActiveSpline = (time: number) => {
    if (!activeSplineEffect) return time;
    return Math.min(
      activeSplineEffect.start + activeSplineEffect.duration,
      Math.max(activeSplineEffect.start, time),
    );
  };
  const valueOnLine = (time: number) => {
    const nextIndex = sorted.findIndex((point) => point.time >= time);
    const after = nextIndex < 0 ? sorted[sorted.length - 1] : sorted[nextIndex];
    const before = nextIndex <= 0 ? sorted[0] : sorted[nextIndex - 1];
    if (!before || !after || before.time === after.time) return before?.value ?? 0;
    const amount = (time - before.time) / (after.time - before.time);
    return before.value + (after.value - before.value) * amount;
  };

  return <div className="curveLane" style={{ width }}>
    <LaneBeatLines beatTimes={beatTimes} zoom={zoom} />
    <div className="laneLabel"><span>INTENSITY</span><div className="curveMode">
      <button className={data.curve === "straight" ? "selected" : ""} onClick={() => onChange({ ...data, curve: "straight" })}>Straight</button>
      <button className={data.curve === "smooth" ? "selected" : ""} onClick={() => onChange({ ...data, curve: "smooth" })}>Curve</button>
    </div></div>
    <div className="effectLane">
      <span className="effectLaneLabel">EFFECTS</span>
      <div className="effectRegionLayer">
      {data.effects.map((effect) => (
        <button
          key={effect.id}
          type="button"
          className={`effectRegion effectRegion-${effect.type} ${selectedEffectKey === `${fixtureId}:${effect.id}` ? "effectRegionSelected" : ""}`}
          style={{ left: effect.start * zoom, width: Math.max(28, effect.duration * zoom) }}
          onClick={(event) => {
            event.stopPropagation();
            onSelectEffect(fixtureId, effect);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenItemContextMenu({
              kind: "effect",
              x: event.clientX,
              y: event.clientY,
              fixtureId,
              effectId: effect.id,
            });
          }}
        >
          <strong>{effect.type === "spline" ? "SPLINE" : effect.type.toUpperCase()}</strong>
          <span>{clock(effect.start)} · {effect.duration.toFixed(1)}s</span>
        </button>
      ))}
      </div>
    </div>
    <svg ref={svgRef} className="curveSvg" width={width} height="150"
      onPointerDown={(event) => {
        if (event.ctrlKey || event.metaKey) {
          const bounds = svgRef.current?.getBoundingClientRect();
          if (bounds) {
            const pointerTime = Math.min(
              duration,
              Math.max(0, (event.clientX - bounds.left) / zoom),
            );
            const pointerValue = Math.min(
              1,
              Math.max(0, 1 - (event.clientY - bounds.top) / bounds.height),
            );
            const horizontalSegment = sorted.slice(0, -1).find((left, index) => {
              const right = sorted[index + 1];
              return (
                Math.abs(left.value - right.value) < 0.001 &&
                pointerTime >= left.time &&
                pointerTime <= right.time &&
                Math.abs(pointerValue - left.value) * bounds.height <= 12
              );
            });
            const verticalSegment = sorted.slice(0, -1).find((left, index) => {
              const right = sorted[index + 1];
              return (
                Math.abs(left.time - right.time) < 0.001 &&
                Math.abs(pointerTime - left.time) * zoom <= 12 &&
                pointerValue >= Math.min(left.value, right.value) &&
                pointerValue <= Math.max(left.value, right.value)
              );
            });
            const segment = horizontalSegment ?? verticalSegment;
            if (segment) {
              const sortedIndex = sorted.indexOf(segment);
              const orientation = horizontalSegment ? "horizontal" : "vertical";
              if (!(orientation === "vertical" && sortedIndex === 0)) {
                event.preventDefault();
                segmentDrag.current = {
                  orientation,
                  leftIndex: data.points.indexOf(segment),
                  rightIndex: data.points.indexOf(sorted[sortedIndex + 1]),
                  startX: event.clientX,
                  startY: event.clientY,
                  startTime: segment.time,
                  startValue: segment.value,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                return;
              }
            }
          }
        }
        gesture.current = { x: event.clientX, y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = segmentDrag.current;
        if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) {
          if (drag.orientation === "vertical") {
            const nextTime = Math.min(
              duration,
              Math.max(
                0,
                snap(
                  drag.startTime + (event.clientX - drag.startX) / zoom,
                  grid,
                ),
              ),
            );
            onChange({
              ...data,
              points: data.points.map((item, index) =>
                index === drag.leftIndex || index === drag.rightIndex
                  ? { ...item, time: nextTime }
                  : item,
              ),
            });
          } else {
            const nextValue = Math.min(
              1,
              Math.max(0, drag.startValue - (event.clientY - drag.startY) / 150),
            );
            onChange({
              ...data,
              points: data.points.map((item, index) =>
                index === drag.leftIndex || index === drag.rightIndex
                  ? { ...item, value: nextValue }
                  : item,
              ),
            });
          }
          return;
        }
        if (!gesture.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const deltaX = event.clientX - gesture.current.x;
        const deltaY = event.clientY - gesture.current.y;
        if (Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY)) {
          gesture.current.moved = true;
          onPan(deltaX);
          gesture.current.x = event.clientX;
          gesture.current.y = event.clientY;
        }
      }}
      onPointerUp={(event) => {
        if (segmentDrag.current) {
          segmentDrag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          return;
        }
        if (gesture.current && !gesture.current.moved) {
          const point = toPoint(event.clientX, event.clientY);
          if (
            point &&
            (!activeSplineEffect || isWithinActiveSpline(point.time)) &&
            Math.abs(point.value - valueOnLine(point.time)) * 150 <= 10
          ) {
            const adjustedPoint = activeSplineEffect
              ? { ...point, time: clampToActiveSpline(point.time) }
              : point;
            onChange({
              ...data,
              points: [...data.points, adjustedPoint].sort((a, b) => a.time - b.time),
            });
          }
        }
        gesture.current = null;
      }}>
      <defs>
        <linearGradient id="intensityFillBlue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8fbff" stopOpacity=".32" />
          <stop offset=".55" stopColor="#8bc1ff" stopOpacity=".14" />
          <stop offset="1" stopColor="#3185ff" stopOpacity=".02" />
        </linearGradient>
      </defs>
      <path className="curveArea" d={`${path} L ${(sorted[sorted.length - 1]?.time ?? 0) * zoom} 150 L 0 150 Z`} />
      <path className="curveBackdrop" d={path} />
      <path
        className="intensityPath"
        d={path}
        onPointerDown={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          const point = toPoint(event.clientX, event.clientY);
          if (!point) return;
          const horizontalSegment = sorted.slice(0, -1).find((left, index) => {
            const right = sorted[index + 1];
            return (
              Math.abs(left.value - right.value) < 0.001 &&
              point.time >= left.time &&
              point.time <= right.time
            );
          });
          const verticalSegment = sorted.slice(0, -1).find((left, index) => {
            const right = sorted[index + 1];
            return (
              Math.abs(left.time - right.time) < 0.001 &&
              point.value >= Math.min(left.value, right.value) &&
              point.value <= Math.max(left.value, right.value)
            );
          });
          const segment = horizontalSegment ?? verticalSegment;
          if (!segment) return;
          const index = sorted.indexOf(segment);
          const orientation = horizontalSegment ? "horizontal" : "vertical";
          if (orientation === "vertical" && index === 0) return;
          event.preventDefault();
          event.stopPropagation();
          segmentDrag.current = {
            orientation,
            leftIndex: data.points.indexOf(segment),
            rightIndex: data.points.indexOf(sorted[index + 1]),
            startX: event.clientX,
            startY: event.clientY,
            startTime: segment.time,
            startValue: segment.value,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = segmentDrag.current;
          if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          if (drag.orientation === "vertical") {
            const nextTime = Math.min(
              duration,
              Math.max(
                0,
                snap(
                  drag.startTime + (event.clientX - drag.startX) / zoom,
                  grid,
                ),
              ),
            );
            onChange({
              ...data,
              points: data.points.map((item, index) =>
                  index === drag.leftIndex || index === drag.rightIndex
                    ? { ...item, time: nextTime }
                    : item,
                ),
            });
            return;
          }
          const nextValue = Math.min(
            1,
            Math.max(0, drag.startValue - (event.clientY - drag.startY) / 150),
          );
          onChange({
            ...data,
            points: data.points.map((item, index) =>
              index === drag.leftIndex || index === drag.rightIndex
                ? { ...item, value: nextValue }
                : item,
            ),
          });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          segmentDrag.current = null;
        }}
        onPointerCancel={() => {
          segmentDrag.current = null;
        }}
      />
      {sorted.map((point, index) => <circle className="waypoint" key={index} cx={Math.max(7, point.time * zoom)} cy={(1 - point.value) * 150} r="6"
        onPointerDown={(event) => {
          event.stopPropagation();
          const pointerPoint = toPoint(event.clientX, event.clientY);
          waypointDrag.current = {
            point,
            timeOffset: (pointerPoint?.time ?? point.time) - point.time,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const next = toPoint(event.clientX, event.clientY);
          if (!next) return;
          if (activeSplineEffect && !isWithinActiveSpline(point.time)) return;
          const neighborValues = [sorted[index - 1], sorted[index + 1]]
            .filter((neighbor): neighbor is Point => Boolean(neighbor))
            .map((neighbor) => neighbor.value);
          const snappedValue =
            (event.ctrlKey || event.metaKey) && neighborValues.length
              ? neighborValues.reduce((closest, value) =>
                  Math.abs(value - next.value) < Math.abs(closest - next.value)
                    ? value
                    : closest,
                )
              : next.value;
          const draggedTime = Math.max(
            0,
            Math.min(
              duration,
              next.time - (waypointDrag.current?.timeOffset ?? 0),
            ),
          );
          const adjusted =
            index === 0
              ? { ...next, time: point.time, value: snappedValue }
              : activeSplineEffect
                ? {
                    ...next,
                    time: clampToActiveSpline(draggedTime),
                    value: snappedValue,
                  }
                : { ...next, time: draggedTime, value: snappedValue };
          onChange({ ...data, points: data.points.map((item) => item === point ? adjusted : item).sort((a, b) => a.time - b.time) });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          waypointDrag.current = null;
        }}
        onPointerCancel={() => {
          waypointDrag.current = null;
        }} />)}
    </svg>
  </div>;
}

function ColorLane({ fixtureId, clips, transitions, zoom, grid, duration, width, beatTimes, onChange, onPreviewColorChange, selectedColorKey, onSelectColorClip, onRequestColorTransition, onOpenItemContextMenu }: {
  fixtureId: string;
  clips: ColorClip[]; zoom: number; grid: number; duration: number; width: number;
  transitions: ColorTransition[];
  beatTimes: number[];
  onChange: (clips: ColorClip[], transitions: ColorTransition[]) => void;
  onPreviewColorChange: (color: string | null) => void;
  selectedColorKey: string | null;
  onSelectColorClip: (key: string) => void;
  onRequestColorTransition: (fixtureId: string, leftClipId: string, rightClipId: string) => void;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
}) {
  const [transitionLengthEditor, setTransitionLengthEditor] = useState<{
    id: string;
    duration: number;
  } | null>(null);
  const lastEnd = clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  const sortedClips = [...clips].sort((a, b) => a.start - b.start);
  const touchingBoundaries = sortedClips.slice(0, -1).flatMap((leftClip, index) => {
    const rightClip = sortedClips[index + 1];
    const boundary = leftClip.start + leftClip.duration;
    return Math.abs(boundary - rightClip.start) <= 0.01
      ? [{ leftClip, rightClip, boundary }]
      : [];
  });
  const commit = (next: ColorClip[]) =>
    onChange(rippleColors(next, duration), transitions);

  const saveTransitionLength = () => {
    if (!transitionLengthEditor) return;
    const transition = transitions.find(
      (item) => item.id === transitionLengthEditor.id,
    );
    if (!transition) {
      setTransitionLengthEditor(null);
      return;
    }

    const oldHalf = transition.duration / 2;
    const boundary = transition.boundary ?? transition.start + oldHalf;
    const leftClip = clips.find((clip) => clip.id === transition.leftClipId);
    const rightClip = clips.find((clip) => clip.id === transition.rightClipId);
    const availableHalf = Math.max(
      0.05,
      Math.min(
        boundary,
        duration - boundary,
        leftClip ? leftClip.duration + oldHalf - 0.05 : Number.POSITIVE_INFINITY,
        rightClip ? rightClip.duration + oldHalf - 0.05 : Number.POSITIVE_INFINITY,
      ),
    );
    const nextHalf = Math.min(
      availableHalf,
      Math.max(0.05, transitionLengthEditor.duration / 2),
    );
    const halfDelta = nextHalf - oldHalf;

    onChange(
      clips.map((clip) => {
        if (clip.id === transition.leftClipId) {
          return {
            ...clip,
            duration: Math.max(0.05, clip.duration - halfDelta),
          };
        }
        if (clip.id === transition.rightClipId) {
          return {
            ...clip,
            start: clip.start + halfDelta,
            duration: Math.max(0.05, clip.duration - halfDelta),
          };
        }
        return clip;
      }),
      transitions.map((item) =>
        item.id === transition.id
          ? {
              ...item,
              start: boundary - nextHalf,
              duration: nextHalf * 2,
              boundary,
            }
          : item,
      ),
    );
    setTransitionLengthEditor(null);
  };

  return <>
  <div className="parameterLane colorLane" style={{ width }}>
    <LaneBeatLines beatTimes={beatTimes} zoom={zoom} />
    <span>COLOR</span>
    {clips.map((clip, index) => (
      <ColorClipBlock
        key={clip.id}
        clip={clip}
        index={index}
        clips={clips}
        zoom={zoom}
        grid={grid}
        duration={duration}
        minimumStart={transitions
          .filter((transition) => transition.rightClipId === clip.id)
          .reduce(
            (minimum, transition) =>
              Math.max(minimum, transition.start + transition.duration),
            0,
          )}
        commit={commit}
        onPreviewColorChange={onPreviewColorChange}
        fixtureId={fixtureId}
        selected={selectedColorKey === `${fixtureId}:${clip.id}`}
        onSelect={() => onSelectColorClip(`${fixtureId}:${clip.id}`)}
        onOpenItemContextMenu={onOpenItemContextMenu}
      />
    ))}
    {transitions.map((transition) => (
      <button
        key={transition.id}
        type="button"
        className="colorTransitionBlock"
        style={{
          left: transition.start * zoom,
          width: Math.max(24, transition.duration * zoom),
          "--transition-from": transition.fromColor,
          "--transition-to": transition.toColor,
          background: `linear-gradient(90deg, ${transition.fromColor}, ${transition.toColor})`,
        } as CSSProperties}
        title={`${transition.duration.toFixed(1)} second color transition`}
        onClick={(event) => {
          event.stopPropagation();
          setTransitionLengthEditor({
            id: transition.id,
            duration: transition.duration,
          });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenItemContextMenu({
            kind: "colorTransition",
            x: event.clientX,
            y: event.clientY,
            fixtureId,
            transitionId: transition.id,
          });
        }}
      >
        <strong>TRANSITION</strong>
        <span>{transition.duration.toFixed(1)}s</span>
      </button>
    ))}
    {touchingBoundaries.map(({ leftClip, rightClip, boundary }) => (
      <button
        type="button"
        key={`${leftClip.id}:${rightClip.id}`}
        className="colorTransitionBoundary"
        style={{ left: boundary * zoom }}
        aria-label="Add color transition"
        onClick={(event) => {
          event.stopPropagation();
          onRequestColorTransition(fixtureId, leftClip.id, rightClip.id);
        }}
      >
        <span>+ Color transition</span>
      </button>
    ))}
    <button className="addColorButton" style={{ left: lastEnd * zoom + 6 }} disabled={lastEnd >= duration}
      onClick={() => commit([...clips, { id: uid(), start: snap(lastEnd, grid),
        duration: Math.min(4, duration - lastEnd), color: COLORS[clips.length % COLORS.length] }])}>+</button>
  </div>
  {transitionLengthEditor ? (
    <div
      className="effectDialogBackdrop"
      onPointerDown={() => setTransitionLengthEditor(null)}
    >
      <div
        className="effectDialog colorTransitionDialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="effectDialogHeader">
          <div>
            <strong>Edit color transition</strong>
            <span>Change how long the blend between these colors lasts.</span>
          </div>
          <button type="button" onClick={() => setTransitionLengthEditor(null)}>
            ×
          </button>
        </div>
        <label>
          Transition duration
          <div className="transitionDurationInput">
            <input
              type="number"
              min="0.1"
              max="30"
              step="0.1"
              value={transitionLengthEditor.duration}
              onChange={(event) =>
                setTransitionLengthEditor((previous) =>
                  previous
                    ? {
                        ...previous,
                        duration: Math.max(0.1, Number(event.target.value)),
                      }
                    : previous,
                )
              }
            />
            <span>seconds</span>
          </div>
        </label>
        <div className="effectDialogActions">
          <span />
          <div>
            <button type="button" onClick={() => setTransitionLengthEditor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primaryButton"
              onClick={saveTransitionLength}
            >
              Save length
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null}
  </>;
}

const ColorClipBlock = memo(function ColorClipBlock({
  clip,
  index,
  clips,
  zoom,
  grid,
  duration,
  minimumStart,
  commit,
  onPreviewColorChange,
  fixtureId,
  selected,
  onSelect,
  onOpenItemContextMenu,
}: {
  clip: ColorClip;
  index: number;
  clips: ColorClip[];
  zoom: number;
  grid: number;
  duration: number;
  minimumStart: number;
  commit: (clips: ColorClip[]) => void;
  onPreviewColorChange: (color: string | null) => void;
  fixtureId: string;
  selected: boolean;
  onSelect: () => void;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewTimerRef = useRef<number | null>(null);
  const pendingPreviewColorRef = useRef<string | null>(null);

  const flushPreviewColor = (color: string | null) => {
    pendingPreviewColorRef.current = color;
    if (previewTimerRef.current !== null) return;
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      onPreviewColorChange(pendingPreviewColorRef.current);
    }, 75);
  };

  useEffect(() => {
    if (blockRef.current) {
      blockRef.current.style.background = clip.color;
    }
    if (inputRef.current && inputRef.current.value !== clip.color) {
      inputRef.current.value = clip.color;
    }
  }, [clip.color]);

  useEffect(() => () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
    }
  }, []);

  return (
    <div
      ref={blockRef}
      className={`colorBlock ${selected ? "colorBlockSelected" : ""}`}
      style={{ left: clip.start * zoom, width: clip.duration * zoom, background: clip.color }}
      onPointerDown={() => onSelect()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        onOpenItemContextMenu({
          kind: "color",
          x: event.clientX,
          y: event.clientY,
          fixtureId,
          clipId: clip.id,
        });
      }}
    >
      <input
        ref={inputRef}
        type="color"
        defaultValue={clip.color}
        onPointerDown={(event) => {
          event.stopPropagation();
          flushPreviewColor(inputRef.current?.value ?? clip.color);
        }}
        onFocus={() => flushPreviewColor(inputRef.current?.value ?? clip.color)}
        onInput={(event) => {
          if (blockRef.current) {
            blockRef.current.style.background = event.currentTarget.value;
          }
          flushPreviewColor(event.currentTarget.value);
        }}
        onChange={(event) => {
          const nextColor = event.currentTarget.value;
          flushPreviewColor(nextColor);
          commit(clips.map((item) => item.id === clip.id ? { ...item, color: nextColor } : item));
        }}
        onBlur={() => flushPreviewColor(null)}
      />
      <b
        className="clipDragSurface"
        onPointerDown={(event) => {
          event.currentTarget.dataset.startX = String(event.clientX);
          event.currentTarget.dataset.clipStart = String(clip.start);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const originalStart = Number(event.currentTarget.dataset.clipStart);
          const nextStart = snap(
            originalStart +
              (event.clientX - Number(event.currentTarget.dataset.startX)) / zoom,
            grid,
          );
          commit(clips.map((item) =>
            item.id === clip.id
              ? {
                  ...item,
                  start: Math.max(
                    minimumStart,
                    Math.min(duration - item.duration, nextStart),
                  ),
                }
              : item,
          ));
        }}
      >
        Color {index + 1}
      </b>
      <i
        className="resizeHandle"
        onPointerDown={(event) => {
          event.currentTarget.dataset.startX = String(event.clientX);
          event.currentTarget.dataset.startDuration = String(clip.duration);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const handle = event.currentTarget;
          const startX = Number(handle.dataset.startX ?? event.clientX);
          const startDuration = Number(handle.dataset.startDuration ?? clip.duration);
          handle.dataset.startX = String(startX);
          handle.dataset.startDuration = String(startDuration);
          const nextDuration = Math.max(
            grid,
            snap(startDuration + (event.clientX - startX) / zoom, grid),
          );
          commit(
            clips.map((item) =>
              item.id === clip.id
                ? { ...item, duration: Math.min(duration - clip.start, nextDuration) }
                : item,
            ),
          );
        }}
        onPointerUp={(event) => {
          delete event.currentTarget.dataset.startX;
          delete event.currentTarget.dataset.startDuration;
        }}
      />
    </div>
  );
});

function SelectionLayer({ fixtureId, zoom, selection, active, onChange }: {
  fixtureId: string; zoom: number; selection: Selection | null;
  active: boolean;
  onChange: (selection: Selection | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef(0);
  return <div ref={ref} className={`selectionLayer ${active ? "selectionActive" : "selectionPersisted"}`}
    onPointerDown={(event) => {
      const bounds = ref.current!.getBoundingClientRect();
      start.current = Math.max(0, (event.clientX - bounds.left) / zoom);
      onChange({ fixtureId, start: start.current, end: start.current });
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const bounds = ref.current!.getBoundingClientRect();
      onChange({ fixtureId, start: start.current, end: Math.max(0, (event.clientX - bounds.left) / zoom) });
    }}>
    {selection && <i style={{ left: Math.min(selection.start, selection.end) * zoom,
      width: Math.abs(selection.end - selection.start) * zoom }} />}
  </div>;
}

function getBeatTimes(points: BeatgridPoint[], duration: number) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  return sorted.flatMap((point, index) => {
    const end = sorted[index + 1]?.time ?? duration;
    const interval = 60 / Math.max(1, point.bpm);
    const regionBeats: number[] = [];
    for (let time = point.time; time < end; time += interval) {
      regionBeats.push(time);
    }
    return regionBeats;
  });
}

function getUniqueBeatgridTime(
  points: BeatgridPoint[],
  desiredTime: number,
  duration: number,
) {
  const epsilon = 0.05;
  const normalized = Math.min(duration, Math.max(0, desiredTime));
  const occupied = new Set(points.map((point) => point.time.toFixed(3)));

  if (!occupied.has(normalized.toFixed(3))) {
    return normalized;
  }

  for (let step = 1; step < 200; step += 1) {
    const forward = Math.min(duration, normalized + step * epsilon);
    if (!occupied.has(forward.toFixed(3))) {
      return forward;
    }

    const backward = Math.max(0, normalized - step * epsilon);
    if (!occupied.has(backward.toFixed(3))) {
      return backward;
    }
  }

  return normalized;
}

function layoutBeatgridRegions(
  points: BeatgridPoint[],
  zoom: number,
  duration: number,
) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const rowEnds: number[] = [];
  const regions: BeatgridRegion[] = sorted.map((point, index) => {
    const nextTime = sorted[index + 1]?.time ?? duration;
    const left = point.time * zoom;
    const width = Math.max(58, (nextTime - point.time) * zoom);
    let row = 0;

    while ((rowEnds[row] ?? -Infinity) > left - 6) {
      row += 1;
    }

    rowEnds[row] = left + width;
    return { ...point, row, width, nextTime };
  });

  return { regions, rowCount: Math.max(1, rowEnds.length) };
}

function LaneBeatLines({ beatTimes, zoom }: { beatTimes: number[]; zoom: number }) {
  return (
    <div className="laneBeatLines">
      {beatTimes.map((time, index) => (
        <i key={`${time}-${index}`} style={{ left: time * zoom }} />
      ))}
    </div>
  );
}

function BeatgridLane({
  points,
  playhead,
  zoom,
  width,
  duration,
  onChange,
}: {
  points: BeatgridPoint[];
  playhead: number;
  zoom: number;
  width: number;
  duration: number;
  onChange: (points: BeatgridPoint[]) => void;
}) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const beats = getBeatTimes(points, duration);
  const { regions, rowCount } = layoutBeatgridRegions(points, zoom, duration);
  const laneHeight = 30 + rowCount * 26;

  return (
    <div className="beatgridLane topBeatgrid" style={{ marginLeft: LABEL_WIDTH, width, height: laneHeight }}>
      <div
      className="beatgridLabel"
    >
        <strong>BEATGRID</strong>
        <span>Enter BPM to apply</span>
      </div>
      <div className="beatLines">
        {beats.map((time, index) => (
          <i key={`${time}-${index}`} style={{ left: time * zoom }} />
        ))}
      </div>
      {regions.map((point) => {
        return (
          <div
            key={point.id}
            className="tempoRegion"
            style={{
              left: point.time * zoom,
              top: 30 + point.row * 26,
              height: 20,
              width: point.width,
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (points.length <= 1) return;
              onChange(points.filter((item) => item.id !== point.id));
            }}
          >
            <TempoInput
              value={point.bpm}
              onCommit={(bpm) =>
                onChange(
                  points.map((item) =>
                    item.id === point.id ? { ...item, bpm } : item,
                  ),
                )
              }
            />
            <span>BPM</span>
          </div>
        );
      })}
      <button
        className="addTempoPoint"
        style={{ left: playhead * zoom }}
        onClick={() => {
          const activeTempo =
            [...sorted].reverse().find((point) => point.time <= playhead)?.bpm ??
            120;
          const nextTime = getUniqueBeatgridTime(points, playhead, duration);
          onChange([
            ...points,
            { id: uid(), time: nextTime, bpm: activeTempo },
          ]);
        }}
      >
        + Tempo here
      </button>
    </div>
  );
}

function TempoInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      min="20"
      max="300"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        const bpm = Math.min(300, Math.max(20, Number(draft) || value));
        setDraft(String(bpm));
        onCommit(bpm);
        event.currentTarget.blur();
      }}
    />
  );
}

function StrobeLane({ fixtureId, clips, zoom, grid, duration, width, beatTimes, onChange, onOpenItemContextMenu }: {
  fixtureId: string;
  clips: StrobeClip[]; zoom: number; grid: number; duration: number; width: number;
  beatTimes: number[];
  onChange: (clips: StrobeClip[]) => void;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
}) {
  const lastEnd = clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  const commit = (next: StrobeClip[]) => onChange(next);
  return <div className="parameterLane strobeLane" style={{ width }}>
    <LaneBeatLines beatTimes={beatTimes} zoom={zoom} />
    <span>STROBE</span>
    {clips.map((clip, index) => (
      <StrobeClipBlock
        key={clip.id}
        clip={clip}
        index={index}
        clips={clips}
        zoom={zoom}
        grid={grid}
        duration={duration}
        commit={commit}
        fixtureId={fixtureId}
        onOpenItemContextMenu={onOpenItemContextMenu}
      />
    ))}
    <button className="addRegionButton" style={{ left: lastEnd * zoom + 6 }}
      disabled={lastEnd >= duration}
      onClick={() => onChange([...clips, { id: uid(), start: snap(lastEnd, grid), duration: Math.min(4, duration - lastEnd), rate: 8 }])}>
      + Add strobe
    </button>
  </div>;
}

const StrobeClipBlock = memo(function StrobeClipBlock({
  clip,
  index,
  clips,
  zoom,
  grid,
  duration,
  commit,
  fixtureId,
  onOpenItemContextMenu,
}: {
  clip: StrobeClip;
  index: number;
  clips: StrobeClip[];
  zoom: number;
  grid: number;
  duration: number;
  commit: (clips: StrobeClip[]) => void;
  fixtureId: string;
  onOpenItemContextMenu: (menu: ItemContextMenuState) => void;
}) {
  return (
    <div
      className="strobeClip"
      style={{ left: clip.start * zoom, width: clip.duration * zoom }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenItemContextMenu({
          kind: "strobe",
          x: event.clientX,
          y: event.clientY,
          fixtureId,
          clipId: clip.id,
        });
      }}
    >
      <input
        type="number"
        min="1"
        max="30"
        value={clip.rate}
        onChange={(event) =>
          commit(
            clips.map((item) =>
              item.id === clip.id
                ? { ...item, rate: Number(event.target.value) }
                : item,
            ),
          )
        }
      />
      <b
        className="clipDragSurface"
        onPointerDown={(event) => {
          event.currentTarget.dataset.startX = String(event.clientX);
          event.currentTarget.dataset.clipStart = String(clip.start);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const originalStart = Number(event.currentTarget.dataset.clipStart);
          const nextStart = snap(
            originalStart +
              (event.clientX - Number(event.currentTarget.dataset.startX)) / zoom,
            grid,
          );
          commit(
            clips.map((item) =>
              item.id === clip.id
                ? {
                    ...item,
                    start: Math.min(duration - item.duration, Math.max(0, nextStart)),
                  }
                : item,
            ),
          );
        }}
      >
        Strobe {index + 1} · {clip.rate} Hz
      </b>
      <i
        className="resizeHandle"
        onPointerDown={(event) => {
          event.currentTarget.dataset.startX = String(event.clientX);
          event.currentTarget.dataset.startDuration = String(clip.duration);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const handle = event.currentTarget;
          const startX = Number(handle.dataset.startX ?? event.clientX);
          const startDuration = Number(handle.dataset.startDuration ?? clip.duration);
          handle.dataset.startX = String(startX);
          handle.dataset.startDuration = String(startDuration);
          const nextDuration = Math.max(
            grid,
            snap(startDuration + (event.clientX - startX) / zoom, grid),
          );
          commit(
            clips.map((item) =>
              item.id === clip.id
                ? { ...item, duration: Math.min(duration - clip.start, nextDuration) }
                : item,
            ),
          );
        }}
        onPointerUp={(event) => {
          delete event.currentTarget.dataset.startX;
          delete event.currentTarget.dataset.startDuration;
        }}
      />
    </div>
  );
});

function Waveform({
  samples,
  name,
  width,
  visibleWidth,
  scroll,
}: {
  samples: number[];
  name: string;
  width: number;
  visibleWidth: number;
  scroll: number;
}) {
  const renderWidth = Math.max(width, visibleWidth);
  const topEdge = samples
    .map((sample, index) => {
      const x = samples.length > 1 ? (index / (samples.length - 1)) * 1000 : 0;
      return `${x},${50 - sample * 45}`;
    })
    .join(" ");
  const bottomEdge = [...samples]
    .reverse()
    .map((sample, reverseIndex) => {
      const index = samples.length - reverseIndex - 1;
      const x = samples.length > 1 ? (index / (samples.length - 1)) * 1000 : 0;
      return `${x},${50 + sample * 45}`;
    })
    .join(" ");

  return <div className="waveformDock">
    <div className="waveformLabel"><strong>AUDIO</strong><span>{name}</span></div>
    <div className="waveformWindow">
      <div className="waveformBars" style={{ width: renderWidth, transform: `translateX(${-scroll}px)` }}>
        <svg
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          aria-label={`${name} waveform`}
        >
          <defs>
            <linearGradient id="timelineWaveformFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ecf8ff" stopOpacity=".95" />
              <stop offset=".45" stopColor="#7fd4ff" stopOpacity=".6" />
              <stop offset="1" stopColor="#1a3143" stopOpacity=".18" />
            </linearGradient>
            <linearGradient id="timelineWaveformGlow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#67caff" stopOpacity=".22" />
              <stop offset=".5" stopColor="#dff6ff" stopOpacity=".34" />
              <stop offset="1" stopColor="#67caff" stopOpacity=".22" />
            </linearGradient>
          </defs>
          <polygon points={`${topEdge} ${bottomEdge}`} />
          <polyline points={topEdge} className="waveformRidge" />
          <polyline points={bottomEdge} className="waveformRidge waveformRidgeBottom" />
          <line x1="0" y1="50" x2="1000" y2="50" />
        </svg>
      </div>
    </div>
  </div>;
}

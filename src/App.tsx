import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, WheelEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import "./App.css";
import TimelineEditor, {
  interpolateHexColor,
  type TimelineHistoryState,
  type TimelineDocumentData,
} from "./TimelineEditor";
import {
  createPlaceholderWaveform,
  extractWaveformSamples,
  getWaveformSampleCount,
} from "./audioWaveform";
import disasterLogo from "./assets/disaster-logo.png";
import packageInfo from "../package.json";
import currentReleaseNotes from "../RELEASE_NOTES.md?raw";

type SerialPortDto = {
  portName: string;
  portType: string;
};

type ArtNetNodeDto = {
  ipAddress: string;
  shortName: string;
  longName: string;
};

type FixtureChannel = {
  label: string;
  offset: number;
};

type FixtureMode = {
  id: string;
  name: string;
  channels: FixtureChannel[];
};

type CustomFixtureSaveScope = "project" | "program";

export type PatchedFixture = {
  id: string;
  name: string;
  modeId: string;
  startAddress: number;
};

type ShowDocument = {
  version: 1;
  fixtures: PatchedFixture[];
  customModes: FixtureMode[];
  activeFixtureId: string;
  activeStageId: string;
  stages: StageDocument[];
};

type LegacyShowDocument = {
  version?: 1;
  fixtures?: PatchedFixture[];
  customModes?: FixtureMode[];
  activeFixtureId?: string;
  activeStageId?: string;
  stages?: StageDocument[];
  timeline?: TimelineDocumentData | null;
};

type StagePlotFixture = {
  fixtureId: string;
  x: number;
  y: number;
  direction?: "front" | "back" | "left" | "right";
};

type StageDocument = {
  id: string;
  name: string;
  timeline: TimelineDocumentData | null;
  plot2d?: StagePlotFixture[];
};

type StageUndoSnapshot = {
  stages: StageDocument[];
  activeStageId: string;
};

type StageAudioSource = {
  name: string;
  url: string;
  file?: File;
};

type RecentFileKind = "project" | "audio";

type RecentFileEntry = {
  id: string;
  name: string;
  openedAt: number;
  size: number;
};

type UpdateCheckResult = {
  version: string;
  currentVersion: string;
  date?: string | null;
  body?: string | null;
  downloadSize?: number | null;
};

type UpdateAvailabilityState =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "notConfigured"
  | "error";

const FIXTURE_MODES: FixtureMode[] = [
  {
    id: "rockville-best-par-60-6ch",
    name: "Rockville BEST PAR 60 — 6CH",
    channels: [
      { label: "Red", offset: 0 },
      { label: "Green", offset: 1 },
      { label: "Blue", offset: 2 },
      { label: "White", offset: 3 },
      { label: "Amber", offset: 4 },
      { label: "Purple", offset: 5 },
    ],
  },
  {
    id: "rockville-best-par-60-10ch",
    name: "Rockville BEST PAR 60 — 10CH",
    channels: [
      { label: "Dimmer", offset: 0 },
      { label: "Red", offset: 1 },
      { label: "Green", offset: 2 },
      { label: "Blue", offset: 3 },
      { label: "White", offset: 4 },
      { label: "Amber", offset: 5 },
      { label: "Purple", offset: 6 },
      { label: "Strobe", offset: 7 },
      { label: "Mode", offset: 8 },
      { label: "Color / Speed", offset: 9 },
    ],
  },
  {
    id: "rgbw",
    name: "RGBW",
    channels: [
      { label: "Red", offset: 0 },
      { label: "Green", offset: 1 },
      { label: "Blue", offset: 2 },
      { label: "White", offset: 3 },
    ],
  },
  {
    id: "wrgb",
    name: "WRGB",
    channels: [
      { label: "White", offset: 0 },
      { label: "Red", offset: 1 },
      { label: "Green", offset: 2 },
      { label: "Blue", offset: 3 },
    ],
  },
  {
    id: "dimmer-rgb",
    name: "Dimmer + RGB",
    channels: [
      { label: "Dimmer", offset: 0 },
      { label: "Red", offset: 1 },
      { label: "Green", offset: 2 },
      { label: "Blue", offset: 3 },
    ],
  },
  {
    id: "dimmer-wrgb",
    name: "Dimmer + WRGB",
    channels: [
      { label: "Dimmer", offset: 0 },
      { label: "White", offset: 1 },
      { label: "Red", offset: 2 },
      { label: "Green", offset: 3 },
      { label: "Blue", offset: 4 },
    ],
  },
];

const COMMON_CHANNEL_PRESETS = [
  "Dimmer",
  "Intensity",
  "Red",
  "Green",
  "Blue",
  "White",
  "Amber",
  "Purple",
  "UV",
  "Strobe",
  "Pan",
  "Tilt",
  "Pan Fine",
  "Tilt Fine",
  "Zoom",
  "Focus",
  "Iris",
  "Gobo",
  "Gobo Rotate",
  "Color Wheel",
  "Color / Speed",
  "Mode",
  "Program",
  "Speed",
  "Effect",
  "Reset",
] as const;

const PROGRAM_CUSTOM_MODES_STORAGE_KEY = "disaster.programCustomFixtureModes.v1";
const RECENT_PROJECTS_STORAGE_KEY = "disaster.recentProjects.v1";
const RECENT_AUDIO_STORAGE_KEY = "disaster.recentAudio.v1";
const FONT_FAMILY_STORAGE_KEY = "disaster.fontFamily.v1";
const VISUAL_EFFECTS_STORAGE_KEY = "disaster.visualEffects.v1";
const MINIMIZED_CUE_PREVIEWS_STORAGE_KEY = "disaster.minimizedCuePreviews.v1";
const STAGE_PLOT_ZOOM_STORAGE_KEY = "disaster.stagePlotZoom.v1";
const WORKING_VERSION_SUFFIX = "*";
const RECENT_FILES_DATABASE = "disaster-recent-files";
const RECENT_FILES_STORE = "files";
const MAX_RECENT_FILES = 6;
const ARTNET_ENABLED_STORAGE_KEY = "disaster.artnetEnabled.v1";

function readRecentFiles(storageKey: string): RecentFileEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(value) ? value.slice(0, MAX_RECENT_FILES) : [];
  } catch {
    return [];
  }
}

function openRecentFilesDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(RECENT_FILES_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECENT_FILES_STORE)) {
        database.createObjectStore(RECENT_FILES_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeRecentFile(id: string, file: File) {
  const database = await openRecentFilesDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(RECENT_FILES_STORE, "readwrite");
    transaction.objectStore(RECENT_FILES_STORE).put(file, id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function readStoredRecentFile(id: string) {
  const database = await openRecentFilesDatabase();
  const file = await new Promise<File | null>((resolve, reject) => {
    const request = database
      .transaction(RECENT_FILES_STORE, "readonly")
      .objectStore(RECENT_FILES_STORE)
      .get(id);
    request.onsuccess = () => resolve(request.result instanceof File ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return file;
}

let customFixtureModes: FixtureMode[] = [];

export function setCustomFixtureModes(modes: FixtureMode[]) {
  customFixtureModes = modes;
}

function getAllFixtureModes() {
  return [...FIXTURE_MODES, ...customFixtureModes];
}


export function getFixtureMode(modeId: string) {
  return (
    getAllFixtureModes().find((mode) => mode.id === modeId) ??
    getAllFixtureModes().find((mode) => mode.id === "wrgb") ??
    getAllFixtureModes()[0]
  );
}

function getModeChannelCount(mode: FixtureMode) {
  return Math.max(...mode.channels.map((channel) => channel.offset)) + 1;
}

function getFixtureEndAddress(fixture: PatchedFixture) {
  const mode = getFixtureMode(fixture.modeId);
  return fixture.startAddress + getModeChannelCount(mode) - 1;
}

function makeFixtureId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

function getPortLabel(port: SerialPortDto) {
  if (port.portType.includes("vid: 0x0403")) {
    return `${port.portName} — USB-DMX Cable`;
  }

  if (port.portType.includes("UsbPort")) {
    return `${port.portName} — USB Serial Device`;
  }

  return port.portName;
}

function getPreferredDmxPort(ports: SerialPortDto[]) {
  return (
    ports.find((port) => port.portType.includes("vid: 0x0403")) ??
    ports.find((port) => port.portType.includes("UsbPort"))
  );
}

function getArtNetDeviceId(node: ArtNetNodeDto) {
  return `artnet:${node.ipAddress}`;
}

function getArtNetNodeLabel(node: ArtNetNodeDto) {
  const name = node.shortName || node.longName || "Art-Net Node";
  return `${name} — ${node.ipAddress}`;
}

function ensureDstrFilename(name: string) {
  return name.toLowerCase().endsWith(".dstr") ? name : `${name}.dstr`;
}

type OflSearchEntry = {
  manufacturerKey: string;
  manufacturerName: string;
  fixtureKey: string;
  fixtureName: string;
};

type OflFixtureData = {
  name?: string;
  availableChannels?: Record<string, { name?: string }>;
  modes?: Array<{
    name?: string;
    shortName?: string;
    channels?: Array<string | null>;
  }>;
};

function slugifyModeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function humanizeFixtureKey(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeStageName(value: string) {
  return value.trim().toLowerCase();
}

function updateChangeList(body?: string | null) {
  const changes = (body ?? "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^#+\s*/, ""),
    )
    .filter(
      (line) =>
        line.length > 0 &&
        line.toLowerCase() !== "changes" &&
        line.toLowerCase() !== "recent changes",
    );
  if (changes.length) return changes.slice(0, 7);
  return updateChangeList(currentReleaseNotes);
}

function formatUpdateSize(size?: number | null) {
  if (!size || size <= 0) return "Size unavailable";
  const megabytes = size / (1024 * 1024);
  return megabytes >= 1
    ? `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function App() {
  const displayVersion = `${packageInfo.version}${WORKING_VERSION_SUFFIX}`;
  const [page, setPage] = useState<"app" | "patch" | "timeline" | "stage">("app");
  const [fontFamily, setFontFamily] = useState(
    () => localStorage.getItem(FONT_FAMILY_STORAGE_KEY) ?? "system",
  );
  const [visualEffectsEnabled, setVisualEffectsEnabled] = useState(
    () => localStorage.getItem(VISUAL_EFFECTS_STORAGE_KEY) !== "false",
  );
  const [minimizedCuePreviewsEnabled, setMinimizedCuePreviewsEnabled] = useState(
    () => localStorage.getItem(MINIMIZED_CUE_PREVIEWS_STORAGE_KEY) !== "false",
  );
  const [ports, setPorts] = useState<SerialPortDto[]>([]);
  const [artNetNodes, setArtNetNodes] = useState<ArtNetNodeDto[]>([]);
  const [artNetEnabled, setArtNetEnabled] = useState(
    () => localStorage.getItem(ARTNET_ENABLED_STORAGE_KEY) === "true",
  );
  const [selectedPort, setSelectedPort] = useState("");
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const [artNetUniverse, setArtNetUniverse] = useState(0);
  const [connectionKind, setConnectionKind] =
    useState<"usb" | "artnet" | "mixed" | null>(null);
  const [connected, setConnected] = useState(false);
  const [channels, setChannels] = useState<number[]>(Array(512).fill(0));
  const [status, setStatus] = useState("Not connected");
  const latestChannelsRef = useRef<number[]>(Array(512).fill(0));
  const lastChannelUiUpdateRef = useRef(0);
  const sendTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const connectedPortRef = useRef("");
  const selectedOutputIdsRef = useRef<string[]>([]);
  const artNetEnabledRef = useRef(artNetEnabled);
  const autoConnectingRef = useRef(false);
  const manuallyDisconnectedPortRef = useRef("");
  const [liveOutput, setLiveOutput] = useState(false);
  const previewColorRef = useRef<string | null>(null);
  const previewUpdateFrameRef = useRef<number | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [documentName, setDocumentName] = useState("untitled.dstr");
  const [isDirty, setIsDirty] = useState(true);
  const [customModes, setCustomModes] = useState<FixtureMode[]>([]);
  const [programCustomModes, setProgramCustomModes] = useState<FixtureMode[]>([]);
  const [stageAudioSources, setStageAudioSources] = useState<Record<string, StageAudioSource | null>>({});
  const [stageTimelineHistories, setStageTimelineHistories] = useState<Record<string, TimelineHistoryState>>({});
  const [recentProjects, setRecentProjects] = useState<RecentFileEntry[]>(() =>
    readRecentFiles(RECENT_PROJECTS_STORAGE_KEY),
  );
  const [recentAudio, setRecentAudio] = useState<RecentFileEntry[]>(() =>
    readRecentFiles(RECENT_AUDIO_STORAGE_KEY),
  );
  const [requestedAudioFile, setRequestedAudioFile] = useState<{
    id: string;
    file: File;
  } | null>(null);
  const [fixtureSearchQuery, setFixtureSearchQuery] = useState("");
  const [oflIndex, setOflIndex] = useState<OflSearchEntry[]>([]);
  const [oflLoading, setOflLoading] = useState(false);
  const [oflError, setOflError] = useState("");
  const [stageViewMode, setStageViewMode] = useState<"hub" | "plot2d">("hub");
  const [sharedVolume, setSharedVolume] = useState(0.8);
  const [projectSessionKey, setProjectSessionKey] = useState(0);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateAvailability, setUpdateAvailability] =
    useState<UpdateAvailabilityState>("idle");
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResult | null>(null);
  const [updateStatusDetail, setUpdateStatusDetail] = useState("Haven't checked for updates yet.");
  const [stages, setStages] = useState<StageDocument[]>([
    { id: "stage-1", name: "Stage 1", timeline: null, plot2d: [] },
  ]);
  const [activeStageId, setActiveStageId] = useState("stage-1");
  const latestTimelineOutputRef = useRef<
    Record<
      string,
      { intensity: number; color: string | null; strobe: number | null }
    >
  >({});
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const updaterCardRef = useRef<HTMLElement>(null);
  const openInputRef = useRef<HTMLInputElement>(null);
  const saveHandleRef = useRef<any>(null);
  const lastSavedContentRef = useRef<string | null>(null);
  const stageUndoStackRef = useRef<StageUndoSnapshot[]>([]);
  const suppressTimelineDocumentSyncRef = useRef(false);
  const autoUpdateCheckedRef = useRef(false);

  const [fixtures, setFixtures] = useState<PatchedFixture[]>([
    {
      id: "front-par-1",
      name: "Front PAR 1",
      modeId: "wrgb",
      startAddress: 1,
    },
  ]);
  const [activeFixtureId, setActiveFixtureId] = useState("front-par-1");
  const [draggedPatchFixtureId, setDraggedPatchFixtureId] = useState<string | null>(null);
  const [patchFixtureDropTarget, setPatchFixtureDropTarget] = useState<string | null>(null);
  const [draftFixtureName, setDraftFixtureName] = useState("Front PAR 2");
  const [draftStartAddress, setDraftStartAddress] = useState(5);
  const [draftFixtureModeId, setDraftFixtureModeId] = useState("wrgb");
  const [customFixtureBuilderOpen, setCustomFixtureBuilderOpen] = useState(false);
  const [customModeName, setCustomModeName] = useState("Custom PAR");
  const [customModeChannels, setCustomModeChannels] = useState<string[]>([
    "Dimmer",
    "Red",
    "Green",
    "Blue",
    "White",
    "Strobe",
  ]);
  const [nextCustomChannel, setNextCustomChannel] = useState<string>(
    COMMON_CHANNEL_PRESETS[0],
  );
  const [customModeSaveScope, setCustomModeSaveScope] =
    useState<CustomFixtureSaveScope>("project");
  const activeFixture =
    fixtures.find((fixture) => fixture.id === activeFixtureId) ?? fixtures[0];
  const activeStage =
    stages.find((stage) => stage.id === activeStageId) ?? stages[0];
  const activeFixtureMode = activeFixture
    ? getFixtureMode(activeFixture.modeId)
    : FIXTURE_MODES[0];
  const customFixtureModesForApp = [...customModes, ...programCustomModes];
  const allModes = [...FIXTURE_MODES, ...customFixtureModesForApp];
  const filteredOflFixtures = fixtureSearchQuery.trim()
    ? oflIndex
        .filter((entry) =>
          `${entry.manufacturerName} ${entry.fixtureName}`.toLowerCase().includes(
            fixtureSearchQuery.toLowerCase(),
          ),
        )
        .slice(0, 12)
    : [];

  function buildShowDocument(): ShowDocument {
    return {
      version: 1,
      fixtures,
      customModes,
      activeFixtureId,
      activeStageId,
      stages,
    };
  }

  function getCurrentProjectContent() {
    return JSON.stringify(buildShowDocument(), null, 2);
  }

  function normalizeTimelineDocumentForFixtures(
    document: TimelineDocumentData | null | undefined,
    nextFixtures: PatchedFixture[],
  ) {
    if (!document) return null;
    const fixtureIds = new Set(nextFixtures.map((fixture) => fixture.id));
    const fallbackFixtureId = nextFixtures[0]?.id ?? "";
    return {
      ...document,
      selectedFixtureId:
        document.selectedFixtureId && fixtureIds.has(document.selectedFixtureId)
          ? document.selectedFixtureId
          : fallbackFixtureId,
      fixtureOrder: document.fixtureOrder?.filter((fixtureId) => fixtureIds.has(fixtureId)) ?? [],
      tracks: Object.fromEntries(
        Object.entries(document.tracks ?? {}).filter(([fixtureId]) => fixtureIds.has(fixtureId)),
      ),
      fixtureGroups:
        document.fixtureGroups?.filter((group) =>
          group.fixtureIds.every((fixtureId) => fixtureIds.has(fixtureId)),
        ) ?? [],
    } satisfies TimelineDocumentData;
  }

  function resetRuntimeProjectSession() {
    suppressTimelineDocumentSyncRef.current = true;
    const clearedChannels = Array(512).fill(0);
    latestTimelineOutputRef.current = {};
    previewColorRef.current = null;
    stageUndoStackRef.current = [];
    setChannels(clearedChannels);
    latestChannelsRef.current = clearedChannels;
    setStageAudioSources({});
    setStageViewMode("hub");
    setCustomFixtureBuilderOpen(false);
    setFixtureSearchQuery("");
    setActiveFixtureId("");
    setActiveStageId("");
    setPage("patch");
    setProjectSessionKey((previous) => previous + 1);
    window.setTimeout(() => {
      suppressTimelineDocumentSyncRef.current = false;
    }, 0);
  }

  function applyOpenedProject(project: LegacyShowDocument, filename?: string, handle?: any) {
    const nextFixtures =
      project.fixtures?.length
        ? project.fixtures
        : [
            {
              id: "front-par-1",
              name: "Front PAR 1",
              modeId: "wrgb",
              startAddress: 1,
            },
          ];

    const nextStages =
      project.stages?.length
        ? project.stages.map((stage, index) => ({
            ...stage,
            timeline: normalizeTimelineDocumentForFixtures(
              stage.timeline ?? (index === 0 ? project.timeline ?? null : null),
              nextFixtures,
            ),
            plot2d: stage.plot2d ?? [],
          }))
        : [
            {
              id: "stage-1",
              name: "Stage 1",
              timeline: normalizeTimelineDocumentForFixtures(project.timeline ?? null, nextFixtures),
              plot2d: [],
            },
          ];

    const nextCustomModes = project.customModes ?? [];
    const nextActiveFixtureId =
      project.activeFixtureId && nextFixtures.some((fixture) => fixture.id === project.activeFixtureId)
        ? project.activeFixtureId
        : nextFixtures[0]?.id ?? "";
    const nextActiveStageId =
      project.activeStageId && nextStages.some((stage) => stage.id === project.activeStageId)
        ? project.activeStageId
        : nextStages[0]?.id ?? "stage-1";

    resetRuntimeProjectSession();
    setCustomModes(nextCustomModes);
    setFixtures(nextFixtures);
    setActiveFixtureId(nextActiveFixtureId);
    setStages(nextStages);
    setStageTimelineHistories({});
    setActiveStageId(nextActiveStageId);
    setDraftFixtureModeId(nextFixtures[0]?.modeId ?? "wrgb");
    setDraftFixtureName(`Fixture ${nextFixtures.length + 1}`);
    const lastFixture =
      nextFixtures.length > 0 ? nextFixtures[nextFixtures.length - 1] : null;
    setDraftStartAddress(
      Math.min(512, lastFixture ? getFixtureEndAddress(lastFixture) + 1 : 1),
    );
    setDocumentName(filename ? ensureDstrFilename(filename) : "untitled.dstr");
    saveHandleRef.current = handle ?? null;
    const serialized = JSON.stringify(
      {
        version: 1,
        fixtures: nextFixtures,
        customModes: nextCustomModes,
        activeFixtureId: nextActiveFixtureId,
        activeStageId: nextActiveStageId,
        stages: nextStages,
      } satisfies ShowDocument,
      null,
      2,
    );
    lastSavedContentRef.current = serialized;
    setIsDirty(false);
    setStatus(`Opened ${filename ?? "project"}.`);
  }

  async function rememberRecentFile(kind: RecentFileKind, file: File) {
    const id = `${kind}:${file.name.trim().toLowerCase()}`;
    const entry: RecentFileEntry = {
      id,
      name: file.name,
      openedAt: Date.now(),
      size: file.size,
    };
    try {
      await storeRecentFile(id, file);
      const storageKey =
        kind === "project" ? RECENT_PROJECTS_STORAGE_KEY : RECENT_AUDIO_STORAGE_KEY;
      const setter = kind === "project" ? setRecentProjects : setRecentAudio;
      setter((previous) => {
        const next = [entry, ...previous.filter((item) => item.id !== id)].slice(
          0,
          MAX_RECENT_FILES,
        );
        localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    } catch (error) {
      setStatus(`Could not save ${file.name} to recents: ${String(error)}`);
    }
  }

  async function openRecentProject(entry: RecentFileEntry) {
    try {
      const file = await readStoredRecentFile(entry.id);
      if (!file) throw new Error("The stored project copy is no longer available.");
      await openProjectFromFile(file);
    } catch (error) {
      setStatus(`Recent project error: ${String(error)}`);
    }
  }

  async function openRecentAudioFile(entry: RecentFileEntry) {
    try {
      const file = await readStoredRecentFile(entry.id);
      if (!file) throw new Error("The stored audio copy is no longer available.");
      setRequestedAudioFile({ id: `${entry.id}:${Date.now()}`, file });
      setPage("timeline");
    } catch (error) {
      setStatus(`Recent audio error: ${String(error)}`);
    }
  }

  async function openProjectFromFile(file: File, handle?: any) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as LegacyShowDocument;
      applyOpenedProject(parsed, file.name, handle);
      void rememberRecentFile("project", file);
    } catch (err) {
      setStatus(`Open error: ${String(err)}`);
    } finally {
      if (openInputRef.current) {
        openInputRef.current.value = "";
      }
      setFileMenuOpen(false);
    }
  }

  async function openProject() {
    if (isTauri()) {
      try {
        const path = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "Disaster Timeline Show", extensions: ["dstr"] }],
        });
        if (!path || Array.isArray(path)) return;
        const text = await readTextFile(path);
        const filename = path.split(/[\\/]/).pop() ?? "project.dstr";
        const file = new File([text], filename, {
          type: "application/x-disaster-show",
        });
        await openProjectFromFile(file, path);
      } catch (err) {
        setStatus(`Open error: ${String(err)}`);
        setFileMenuOpen(false);
      }
      return;
    }

    const picker = (window as Window & {
      showOpenFilePicker?: (options: unknown) => Promise<any[]>;
    }).showOpenFilePicker;

    try {
      if (picker) {
        const [handle] = await picker({
          multiple: false,
          types: [
            {
              description: "Disaster Timeline Show",
              accept: { "application/x-disaster-show": [".dstr"] },
            },
          ],
        });
        if (!handle) return;
        const file = await handle.getFile();
        await openProjectFromFile(file, handle);
        return;
      }

      openInputRef.current?.click();
    } catch (err) {
      setStatus(`Open error: ${String(err)}`);
      setFileMenuOpen(false);
    }
  }

  async function loadOflIndex() {
    if (oflIndex.length || oflLoading) return;
    setOflLoading(true);
    setOflError("");
    try {
      const [manufacturersResponse, treeResponse] = await Promise.all([
        fetch("https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/fixtures/manufacturers.json"),
        fetch("https://api.github.com/repos/OpenLightingProject/open-fixture-library/git/trees/master?recursive=1"),
      ]);
      const manufacturersJson = await manufacturersResponse.json() as Record<string, { name?: string }>;
      const treeJson = await treeResponse.json() as { tree?: Array<{ path: string; type: string }> };
      const entries = (treeJson.tree ?? [])
        .filter((entry) => entry.type === "blob")
        .map((entry) => {
          const match = entry.path.match(/^fixtures\/([^/]+)\/([^/]+)\.json$/);
          if (!match || match[2] === "manufacturers") return null;
          const [, manufacturerKey, fixtureKey] = match;
          return {
            manufacturerKey,
            manufacturerName:
              manufacturersJson[manufacturerKey]?.name ?? humanizeFixtureKey(manufacturerKey),
            fixtureKey,
            fixtureName: humanizeFixtureKey(fixtureKey),
          } satisfies OflSearchEntry;
        })
        .filter((entry): entry is OflSearchEntry => Boolean(entry))
        .sort((a, b) =>
          `${a.manufacturerName} ${a.fixtureName}`.localeCompare(
            `${b.manufacturerName} ${b.fixtureName}`,
          ),
        );
      setOflIndex(entries);
    } catch (err) {
      setOflError(`Open Fixture Library error: ${String(err)}`);
    } finally {
      setOflLoading(false);
    }
  }

  async function importOflFixture(entry: OflSearchEntry) {
    try {
      setOflError("");
      const response = await fetch(
        `https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/fixtures/${entry.manufacturerKey}/${entry.fixtureKey}.json`,
      );
      const data = await response.json() as OflFixtureData;
      const fixtureName = data.name ?? entry.fixtureName;
      const modes = (data.modes ?? [])
        .map((mode) => {
          const modeName = mode.name ?? mode.shortName ?? "Mode";
          return {
            id: `ofl:${entry.manufacturerKey}/${entry.fixtureKey}/${slugifyModeName(mode.shortName ?? modeName)}`,
            name: `${entry.manufacturerName} ${fixtureName} — ${modeName}`,
            channels: (mode.channels ?? [])
              .map((channelKey, index) => {
                if (channelKey === null) return null;
                return {
                  label: data.availableChannels?.[channelKey]?.name ?? channelKey,
                  offset: index,
                };
              })
              .filter((channel): channel is FixtureChannel => Boolean(channel)),
          } satisfies FixtureMode;
        })
        .filter((mode) => mode.channels.length > 0);

      if (!modes.length) {
        setOflError(`No usable modes found for ${fixtureName}.`);
        return;
      }

    setCustomModes((previous) => [
        ...previous.filter((mode) => !modes.some((nextMode) => nextMode.id === mode.id)),
        ...modes,
      ]);
      setDraftFixtureModeId(modes[0].id);
      setDraftFixtureName(fixtureName);
      setFixtureSearchQuery(`${entry.manufacturerName} ${fixtureName}`);
      setStatus(`Imported ${fixtureName} from Open Fixture Library.`);
    } catch (err) {
      setOflError(`Open Fixture Library import error: ${String(err)}`);
    }
  }

  const updateActiveStageTimeline = useCallback((document: TimelineDocumentData) => {
    if (suppressTimelineDocumentSyncRef.current) return;
    setStages((previous) =>
      previous.map((stage) =>
        stage.id === activeStageId ? { ...stage, timeline: document } : stage,
      ),
    );
  }, [activeStageId]);

  const updateActiveStageTimelineHistory = useCallback((history: TimelineHistoryState) => {
    setStageTimelineHistories((previous) => ({
      ...previous,
      [activeStageId]: history,
    }));
  }, [activeStageId]);

  function pushStageUndoSnapshot() {
    stageUndoStackRef.current.push({
      stages: stages.map((stage) => ({ ...stage })),
      activeStageId,
    });
    if (stageUndoStackRef.current.length > 100) {
      stageUndoStackRef.current.shift();
    }
  }

  function undoStageChange() {
    const previous = stageUndoStackRef.current.pop();
    if (!previous) return false;
    setStages(previous.stages);
    setActiveStageId(previous.activeStageId);
    setStatus("Undid stage change.");
    return true;
  }

  function addStage() {
    let nextIndex = stages.length + 1;
    let nextName = `Stage ${nextIndex}`;
    while (
      stages.some((stage) => normalizeStageName(stage.name) === normalizeStageName(nextName))
    ) {
      nextIndex += 1;
      nextName = `Stage ${nextIndex}`;
    }
    pushStageUndoSnapshot();
    const newStage: StageDocument = {
      id: makeFixtureId(),
      name: nextName,
      timeline: null,
      plot2d: [],
    };
    setStages((previous) => [...previous, newStage]);
    setActiveStageId(newStage.id);
  }

  function renameStage(stageId: string) {
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) return;
    const nextName = window.prompt("Rename stage", stage.name);
    if (!nextName?.trim()) return;
    const trimmedName = nextName.trim();
    if (
      stages.some(
        (item) =>
          item.id !== stageId &&
          normalizeStageName(item.name) === normalizeStageName(trimmedName),
      )
    ) {
      setStatus(`A stage named "${trimmedName}" already exists.`);
      return;
    }
    pushStageUndoSnapshot();
    setStages((previous) =>
      previous.map((item) =>
        item.id === stageId ? { ...item, name: trimmedName } : item,
      ),
    );
  }

  function removeStage(stageId: string) {
    if (stages.length <= 1) {
      setStatus("At least one stage is required.");
      return;
    }
    pushStageUndoSnapshot();
    const remaining = stages.filter((stage) => stage.id !== stageId);
    setStages(remaining);
    if (activeStageId === stageId) {
      setActiveStageId(remaining[0].id);
    }
  }

  async function writeDocumentToHandle(handle: any, content: string) {
    if (typeof handle === "string") {
      await writeTextFile(handle, content);
      return;
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  function downloadDocument(filename: string, content: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function saveShow(saveAs: boolean) {
    const content = getCurrentProjectContent();
    const picker = (window as Window & {
      showSaveFilePicker?: (options: unknown) => Promise<any>;
    }).showSaveFilePicker;

    try {
      if (!saveAs && saveHandleRef.current) {
        await writeDocumentToHandle(saveHandleRef.current, content);
        lastSavedContentRef.current = content;
        setIsDirty(false);
        setStatus(`Saved ${documentName}.`);
        setFileMenuOpen(false);
        return;
      }

      if (isTauri()) {
        const path = await save({
          defaultPath: ensureDstrFilename(documentName),
          filters: [{ name: "Disaster Timeline Show", extensions: ["dstr"] }],
        });
        if (!path) return;
        const filename = ensureDstrFilename(
          path.split(/[\\/]/).pop() ?? documentName,
        );
        await writeTextFile(path, content);
        saveHandleRef.current = path;
        lastSavedContentRef.current = content;
        setIsDirty(false);
        setDocumentName(filename);
        setStatus(`Saved ${filename}.`);
        return;
      }

      if (picker) {
        const handle = await picker({
          suggestedName: ensureDstrFilename(documentName),
          types: [
            {
              description: "Disaster Timeline Show",
              accept: { "application/x-disaster-show": [".dstr"] },
            },
          ],
        });
        if (!handle) return;
        await writeDocumentToHandle(handle, content);
        saveHandleRef.current = handle;
        lastSavedContentRef.current = content;
        setIsDirty(false);
        setDocumentName(ensureDstrFilename(handle.name || documentName));
        setStatus(`Saved ${ensureDstrFilename(handle.name || documentName)}.`);
      } else {
        const nextName = window.prompt(
          "Save show as",
          ensureDstrFilename(documentName),
        );
        if (!nextName) return;
        const filename = ensureDstrFilename(nextName.trim() || "untitled.dstr");
        downloadDocument(filename, content);
        lastSavedContentRef.current = content;
        setIsDirty(false);
        setDocumentName(filename);
        setStatus(`Downloaded ${filename}.`);
      }
    } catch (err) {
      setStatus(`Save error: ${String(err)}`);
    } finally {
      setFileMenuOpen(false);
    }
  }

  async function newProject() {
    if (isDirty) {
      const shouldDiscard = isTauri()
        ? await confirm("Discard the current unsaved project and start a new one?", {
            title: "New project",
            kind: "warning",
          })
        : window.confirm("Discard the current unsaved project and start a new one?");
      if (!shouldDiscard) return;
    }

    resetRuntimeProjectSession();
    saveHandleRef.current = null;
    lastSavedContentRef.current = null;
    setDocumentName("untitled.dstr");
    setCustomModes([]);
    setCustomModeSaveScope("project");
    setFixtures([
      {
        id: "front-par-1",
        name: "Front PAR 1",
        modeId: "wrgb",
        startAddress: 1,
      },
    ]);
    setActiveFixtureId("front-par-1");
    setDraftFixtureName("Front PAR 2");
    setDraftStartAddress(5);
    setDraftFixtureModeId("wrgb");
    setCustomModeName("Custom PAR");
    setCustomModeChannels(["Dimmer", "Red", "Green", "Blue", "White", "Strobe"]);
    setNextCustomChannel(COMMON_CHANNEL_PRESETS[0]);
    setStages([{ id: "stage-1", name: "Stage 1", timeline: null, plot2d: [] }]);
    setStageTimelineHistories({});
    setActiveStageId("stage-1");
    setStatus("Started a new project.");
    setIsDirty(false);
    setFileMenuOpen(false);
  }

  async function toggleLiveOutput(enabled: boolean) {
    try {
      await invoke("set_live_output", { enabled });
      setLiveOutput(enabled);
      setStatus(enabled ? "Live output enabled." : "Live output disabled.");
    } catch (err) {
      setStatus(`Live output error: ${String(err)}`);
    }
  }

  function getUpdateErrorMessage(error: unknown) {
    const message = String(error);
    const normalized = message.toLowerCase();

    if (
      normalized.includes("disaster_updater_pubkey") ||
      normalized.includes("disaster_updater_endpoints") ||
      normalized.includes("auto-update is not configured")
    ) {
      return "Auto-update is not configured yet. Set DISASTER_UPDATER_PUBKEY and DISASTER_UPDATER_ENDPOINTS for your release builds.";
    }

    return `Update error: ${message}`;
  }

  function getUpdateAvailabilityFromError(error: unknown): UpdateAvailabilityState {
    const message = String(error).toLowerCase();
    if (
      message.includes("disaster_updater_pubkey") ||
      message.includes("disaster_updater_endpoints") ||
      message.includes("auto-update is not configured")
    ) {
      return "notConfigured";
    }
    return "error";
  }

  async function checkForUpdates(manual = false) {
    if (checkingForUpdates) return;

    setCheckingForUpdates(true);
    setUpdateAvailability("checking");
    setUpdateStatusDetail("Checking for updates...");

    try {
      const update = await invoke<UpdateCheckResult | null>("check_for_updates");

      if (!update) {
        setAvailableUpdate(null);
        setUpdateAvailability("upToDate");
        setUpdateStatusDetail("Disaster is up to date.");
        if (manual) {
          setStatus("Disaster is up to date.");
        }
        return;
      }

      setAvailableUpdate(update);
      setUpdateAvailability("available");
      setUpdateStatusDetail(`Disaster ${update.version} is available to install.`);
      setStatus(`Update ${update.version} is available. Review it before installing.`);
    } catch (error) {
      const nextAvailability = getUpdateAvailabilityFromError(error);
      setAvailableUpdate(null);
      setUpdateAvailability(nextAvailability);
      setUpdateStatusDetail(getUpdateErrorMessage(error));
      if (manual) {
        setStatus(getUpdateErrorMessage(error));
      }
    } finally {
      setCheckingForUpdates(false);
    }
  }

  function openUpdaterSection() {
    setPage("app");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updaterCardRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        updaterCardRef.current?.focus({ preventScroll: true });
      });
    });
  }

  async function installAvailableUpdate() {
    if (!availableUpdate || installingUpdate) return;

    const changes = updateChangeList(availableUpdate.body);
    const details = [
      `Install Disaster ${availableUpdate.version}?`,
      `Download size: ${formatUpdateSize(availableUpdate.downloadSize)}`,
      availableUpdate.date ? `Published: ${availableUpdate.date}` : null,
      "",
      "Changes:",
      ...changes.map((change) => `• ${change}`),
      "",
      "The application will restart after installation.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const approved = isTauri()
      ? await confirm(details, {
          title: "Confirm Disaster update",
          kind: "info",
          okLabel: "Yes, install",
          cancelLabel: "Not now",
        })
      : window.confirm(details);
    if (!approved) {
      setStatus(`Update ${availableUpdate.version} was not installed.`);
      return;
    }

    setInstallingUpdate(true);
    setStatus(`Installing Disaster ${availableUpdate.version} update...`);
    setUpdateStatusDetail(`Installing Disaster ${availableUpdate.version} update...`);
    try {
      await invoke("install_pending_update");
    } catch (error) {
      const message = getUpdateErrorMessage(error);
      setStatus(message);
      setUpdateStatusDetail(message);
      setUpdateAvailability("error");
    } finally {
      setInstallingUpdate(false);
    }
  }

  function addFixture() {
  const mode = getFixtureMode(draftFixtureModeId);
  const channelCount = getModeChannelCount(mode);
  const endAddress = draftStartAddress + channelCount - 1;

  if (endAddress > 512) {
    setStatus("Cannot add fixture: fixture would exceed DMX channel 512.");
    return;
  }

  const newFixture: PatchedFixture = {
    id: makeFixtureId(),
    name: draftFixtureName.trim() || `Fixture ${fixtures.length + 1}`,
    modeId: draftFixtureModeId,
    startAddress: draftStartAddress,
  };

  setFixtures((previous) => [...previous, newFixture]);
  setActiveFixtureId(newFixture.id);

  const nextStartAddress = Math.min(512, endAddress + 1);
  setDraftFixtureName(`Fixture ${fixtures.length + 2}`);
  setDraftStartAddress(nextStartAddress);

  setStatus(`Added ${newFixture.name}.`);
}

function addCustomChannel() {
  const trimmedChannel = nextCustomChannel.trim();
  if (!trimmedChannel) {
    setStatus("Choose or type a channel label before adding it.");
    return;
  }

  setCustomModeChannels((previous) => [...previous, trimmedChannel]);
}

function updateCustomChannel(index: number, label: string) {
  setCustomModeChannels((previous) =>
    previous.map((channel, channelIndex) =>
      channelIndex === index ? label : channel,
    ),
  );
}

function removeCustomChannel(index: number) {
  setCustomModeChannels((previous) =>
    previous.filter((_, channelIndex) => channelIndex !== index),
  );
}

function createCustomFixtureMode() {
  const trimmedName = customModeName.trim();
  const normalizedChannels = customModeChannels
    .map((channel) => channel.trim())
    .filter(Boolean);

  if (!trimmedName) {
    setStatus("Custom fixture type needs a name.");
    return;
  }

  if (!normalizedChannels.length) {
    setStatus("Custom fixture type needs at least one channel.");
    return;
  }

  const duplicateMode = allModes.find(
    (mode) => mode.name.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  if (duplicateMode) {
    setStatus(`Fixture type "${trimmedName}" already exists.`);
    setDraftFixtureModeId(duplicateMode.id);
    return;
  }

  const nextMode: FixtureMode = {
    id: `custom:${slugifyModeName(trimmedName) || "fixture"}-${Date.now()}`,
    name: trimmedName,
    channels: normalizedChannels.map((label, offset) => ({ label, offset })),
  };

  if (customModeSaveScope === "program") {
    setProgramCustomModes((previous) => [...previous, nextMode]);
  } else {
    setCustomModes((previous) => [...previous, nextMode]);
  }
  setDraftFixtureModeId(nextMode.id);
  setCustomModeName(`${trimmedName} Copy`);
  setCustomModeChannels(normalizedChannels);
  setStatus(
    `Created custom fixture type ${trimmedName} and saved it to ${customModeSaveScope === "program" ? "the program" : "this project"}.`,
  );
}

function removeCustomFixtureMode(modeId: string) {
  const mode =
    customModes.find((item) => item.id === modeId) ??
    programCustomModes.find((item) => item.id === modeId);
  if (!mode) return;

  const linkedFixture = fixtures.find((fixture) => fixture.modeId === modeId);
  if (linkedFixture) {
    setStatus(
      `Cannot delete ${mode.name}: it is still assigned to ${linkedFixture.name}.`,
    );
    return;
  }

  const wasProgramMode = programCustomModes.some((item) => item.id === modeId);
  if (wasProgramMode) {
    setProgramCustomModes((previous) =>
      previous.filter((item) => item.id !== modeId),
    );
  } else {
    setCustomModes((previous) => previous.filter((item) => item.id !== modeId));
  }
  if (draftFixtureModeId === modeId) {
    setDraftFixtureModeId("wrgb");
  }
  setStatus(
    `Deleted custom fixture type ${mode.name} from ${wasProgramMode ? "the program" : "this project"}.`,
  );
}

function deleteFixture(fixtureId: string) {
  const remainingFixtures = fixtures.filter((fixture) => fixture.id !== fixtureId);

  setFixtures(remainingFixtures);

  if (activeFixtureId === fixtureId) {
    setActiveFixtureId(remainingFixtures[0]?.id ?? "");
  }

  setStatus("Fixture removed.");
}

function reorderPatchedFixture(
  draggedId: string,
  targetId: string,
  placement: "before" | "after",
) {
  if (draggedId === targetId) return;

  const reorderIds = (ids: string[]) => {
    const withoutDragged = ids.filter((id) => id !== draggedId);
    const targetIndex = withoutDragged.indexOf(targetId);
    if (targetIndex < 0) return ids;
    const next = [...withoutDragged];
    next.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, draggedId);
    return next;
  };

  setFixtures((previous) => {
    const byId = new Map(previous.map((fixture) => [fixture.id, fixture]));
    return reorderIds(previous.map((fixture) => fixture.id))
      .map((fixtureId) => byId.get(fixtureId))
      .filter((fixture): fixture is PatchedFixture => Boolean(fixture));
  });
  setStages((previous) =>
    previous.map((stage) =>
      stage.timeline
        ? {
            ...stage,
            timeline: {
              ...stage.timeline,
              fixtureOrder: reorderIds(stage.timeline.fixtureOrder),
            },
          }
        : stage,
    ),
  );
  setIsDirty(true);
  setStatus("Fixture order updated.");
}

function updateFixtureStartAddress(fixtureId: string, startAddress: number) {
  const fixture = fixtures.find((item) => item.id === fixtureId);
  if (!fixture) return;

  const normalizedAddress = Math.min(512, Math.max(1, startAddress));
  const endAddress =
    normalizedAddress + getModeChannelCount(getFixtureMode(fixture.modeId)) - 1;

  if (endAddress > 512) {
    setStatus(`Cannot move ${fixture.name}: it would exceed DMX channel 512.`);
    return;
  }

  setFixtures((previous) =>
    previous.map((item) =>
      item.id === fixtureId
        ? { ...item, startAddress: normalizedAddress }
        : item,
    ),
  );
  setStatus(`${fixture.name} moved to DMX address ${normalizedAddress}.`);
}

function clearFixture(fixture: PatchedFixture) {
  const mode = getFixtureMode(fixture.modeId);

  setChannels((previousChannels) => {
    const next = [...previousChannels];

    for (const fixtureChannel of mode.channels) {
      const actualChannelNumber = fixture.startAddress + fixtureChannel.offset;
      const index = actualChannelNumber - 1;

      if (index >= 0 && index < 512) {
        next[index] = 0;
      }
    }

    latestChannelsRef.current = next;
    queueSend(next);

    return next;
  });

  setStatus(`Cleared ${fixture.name}.`);
}


  async function connectToOutputs(outputIds: string[]) {
    const uniqueOutputs = Array.from(new Set(outputIds)).filter(
      (id) => Boolean(id) && (artNetEnabledRef.current || !id.startsWith("artnet:")),
    );
    if (!uniqueOutputs.length || autoConnectingRef.current) return;

    autoConnectingRef.current = true;
    let outputsOpened = false;
    try {
      await invoke("disconnect_dmx");
      const usbOutput = uniqueOutputs.find((id) => !id.startsWith("artnet:"));
      const artNetOutputs = uniqueOutputs.filter((id) => id.startsWith("artnet:"));
      if (usbOutput) {
        await invoke("connect_dmx", { portName: usbOutput });
      }
      for (const outputId of artNetOutputs) {
        await invoke("connect_artnet", {
          ipAddress: outputId.slice("artnet:".length),
          universe: artNetUniverse,
        });
      }
      outputsOpened = true;
      await invoke("send_dmx", { channels: latestChannelsRef.current });
      await invoke("set_live_output", { enabled: true });
      connectedRef.current = true;
      connectedPortRef.current = uniqueOutputs.join("|");
      selectedOutputIdsRef.current = uniqueOutputs;
      setSelectedOutputIds(uniqueOutputs);
      setSelectedPort(uniqueOutputs[0]);
      setConnected(true);
      setLiveOutput(true);
      const nextKind =
        usbOutput && artNetOutputs.length
          ? "mixed"
          : usbOutput
            ? "usb"
            : "artnet";
      setConnectionKind(nextKind);
      setStatus(
        `Connected to ${uniqueOutputs.length} DMX output${uniqueOutputs.length === 1 ? "" : "s"}${
          artNetOutputs.length ? ` · Art-Net universe ${artNetUniverse}` : ""
        }; live output enabled.`,
      );
    } catch (err) {
      if (outputsOpened) {
        try {
          await invoke("disconnect_dmx");
        } catch {
          // Preserve the original connection error below.
        }
      }
      connectedRef.current = false;
      connectedPortRef.current = "";
      setConnected(false);
      setLiveOutput(false);
      setConnectionKind(null);
      setStatus(`Connection error: ${String(err)}`);
    } finally {
      autoConnectingRef.current = false;
    }
  }

  async function refreshPorts() {
    try {
      const [result, nodes] = await Promise.all([
        invoke<SerialPortDto[]>("list_serial_ports"),
        artNetEnabledRef.current
          ? invoke<ArtNetNodeDto[]>("discover_artnet_nodes").catch(() => [])
          : Promise.resolve([]),
      ]);
      setPorts(result);
      setArtNetNodes(nodes);
      const availableIds = [
        ...result.map((port) => port.portName),
        ...nodes.map(getArtNetDeviceId),
      ];
      const connectedIds = connectedPortRef.current
        .split("|")
        .filter(Boolean);

      if (
        connectedRef.current &&
        connectedIds.some(
          (id) => !id.startsWith("artnet:") && !availableIds.includes(id),
        )
      ) {
        await invoke("disconnect_dmx");
        connectedRef.current = false;
        connectedPortRef.current = "";
        setConnected(false);
        setLiveOutput(false);
        setConnectionKind(null);
        setStatus("USB-DMX device disconnected.");
      }

      const preferredPort = getPreferredDmxPort(result);
      const preferredDevice =
        preferredPort?.portName ??
        (result.length ? result[0].portName : nodes[0] ? getArtNetDeviceId(nodes[0]) : "");
      const retainedSelection = selectedOutputIdsRef.current.filter((id) =>
        availableIds.includes(id),
      );
      const nextSelection = retainedSelection.length
        ? retainedSelection
        : preferredDevice
          ? [preferredDevice]
          : [];
      selectedOutputIdsRef.current = nextSelection;
      setSelectedOutputIds(nextSelection);
      setSelectedPort(nextSelection[0] ?? "");

      if (
        preferredPort &&
        connectedRef.current &&
        !connectedIds.some((id) => !id.startsWith("artnet:"))
      ) {
        const retainedArtNet = connectedIds.filter(
          (id) => id.startsWith("artnet:") && availableIds.includes(id),
        );
        await connectToOutputs([preferredPort.portName, ...retainedArtNet]);
        return;
      }

      if (
        !connectedRef.current &&
        !manuallyDisconnectedPortRef.current &&
        nextSelection.length
      ) {
        await connectToOutputs(nextSelection);
      } else if (!connectedRef.current) {
        if (!result.length && !nodes.length) {
          setStatus(
            artNetEnabledRef.current
              ? "No USB DMX or Art-Net devices found."
              : "No USB DMX devices found. Art-Net is off.",
          );
        } else {
          setStatus(
            `Found ${result.length} serial and ${nodes.length} Art-Net device(s).`,
          );
        }
      }
    } catch (err) {
      setStatus(`Error listing ports: ${String(err)}`);
    }
  }

  async function connect() {
    manuallyDisconnectedPortRef.current = "";
    await connectToOutputs(selectedOutputIdsRef.current);
  }

  async function setArtNetOutputEnabled(enabled: boolean) {
    artNetEnabledRef.current = enabled;
    setArtNetEnabled(enabled);
    localStorage.setItem(ARTNET_ENABLED_STORAGE_KEY, String(enabled));

    if (enabled) {
      void refreshPorts();
      return;
    }

    setArtNetNodes([]);
    const usbOutputs = selectedOutputIdsRef.current.filter(
      (id) => !id.startsWith("artnet:"),
    );
    selectedOutputIdsRef.current = usbOutputs;
    setSelectedOutputIds(usbOutputs);
    setSelectedPort(usbOutputs[0] ?? "");

    if (!connectedRef.current) return;
    if (usbOutputs.length) {
      await connectToOutputs(usbOutputs);
      return;
    }

    await invoke("disconnect_dmx");
    connectedRef.current = false;
    connectedPortRef.current = "";
    setConnected(false);
    setLiveOutput(false);
    setConnectionKind(null);
    setStatus("Art-Net disabled; no USB DMX output is selected.");
  }

  async function disconnect() {
    try {
      await invoke("disconnect_dmx");
      manuallyDisconnectedPortRef.current = "manual";
      connectedRef.current = false;
      connectedPortRef.current = "";
      setConnected(false);
      setLiveOutput(false);
      setConnectionKind(null);
      setStatus("Disconnected");
    } catch (err) {
      setStatus(`Disconnect error: ${String(err)}`);
    }
  }
  function queueSend(nextChannels: number[]) {
    latestChannelsRef.current = nextChannels;

    if (!connected) return;

    if (sendTimerRef.current !== null) {
      return;
    }

    sendTimerRef.current = window.setTimeout(async () => {
      sendTimerRef.current = null;

      try {
        await invoke("send_dmx", {
          channels: latestChannelsRef.current,
        });
      } catch (err) {
        setStatus(`Send error: ${String(err)}`);
      }
    }, 33);
  }

  function updateChannel(channelNumber: number, value: number) {
    const index = channelNumber - 1;

    const next = [...channels];
    next[index] = value;

    setChannels(next);
    queueSend(next);
  }

  function buildFixtureChannels(
    output: Record<
      string,
      { intensity: number; color: string | null; strobe: number | null }
    >,
    forcedColor: string | null = null,
  ) {
    const next = [...latestChannelsRef.current];

    fixtures.forEach((fixture) => {
      const frame = output[fixture.id];
      if (!frame) return;
      const mode = getFixtureMode(fixture.modeId);
      const resolvedColor = forcedColor ?? frame.color;
      const color = resolvedColor
        ? {
            red: parseInt(resolvedColor.slice(1, 3), 16),
            green: parseInt(resolvedColor.slice(3, 5), 16),
            blue: parseInt(resolvedColor.slice(5, 7), 16),
          }
        : null;
      const previewIntensity = forcedColor ? 1 : frame.intensity;
      const strobeValue =
        frame.strobe === null
          ? 0
          : Math.round(Math.min(255, Math.max(1, (frame.strobe / 30) * 255)));

      mode.channels.forEach((channel) => {
        const index = fixture.startAddress + channel.offset - 1;
        const label = channel.label.toLowerCase();
        if (label === "dimmer" || label === "intensity") {
          next[index] = Math.round(previewIntensity * 255);
        } else if (label === "red") {
          next[index] = color ? Math.round(color.red * previewIntensity) : 0;
        } else if (label === "green") {
          next[index] = color ? Math.round(color.green * previewIntensity) : 0;
        } else if (label === "blue") {
          next[index] = color ? Math.round(color.blue * previewIntensity) : 0;
        } else if (label === "white") {
          next[index] = color
            ? Math.round(Math.min(color.red, color.green, color.blue) * previewIntensity)
            : Math.round(previewIntensity * 255);
        } else if (label === "amber") {
          next[index] = color
            ? Math.round(
                Math.min(color.red, (color.red + color.green) / 2) *
                  previewIntensity,
              )
            : 0;
        } else if (label === "purple") {
          next[index] = color
            ? Math.round(((color.red + color.blue) / 2) * previewIntensity)
            : 0;
        } else if (label === "strobe") {
          next[index] = strobeValue;
        }
      });
    });

    return next;
  }

  function applyTimelineFrame(
    output: Record<
      string,
      { intensity: number; color: string | null; strobe: number | null }
    >,
  ) {
    latestTimelineOutputRef.current = output;
    const next = buildFixtureChannels(output, previewColorRef.current);
    queueSend(next);
    const now = performance.now();
    if (now - lastChannelUiUpdateRef.current >= 50) {
      lastChannelUiUpdateRef.current = now;
      setChannels(next);
    }
  }

  function handleColorPreviewChange(color: string | null) {
    if (previewColorRef.current === color) return;
    previewColorRef.current = color;

    if (previewUpdateFrameRef.current !== null) {
      cancelAnimationFrame(previewUpdateFrameRef.current);
    }

    previewUpdateFrameRef.current = requestAnimationFrame(() => {
      previewUpdateFrameRef.current = null;
      if (!Object.keys(latestTimelineOutputRef.current).length) return;
      const next = buildFixtureChannels(
        latestTimelineOutputRef.current,
        previewColorRef.current,
      );
      // Keep native color-picker dragging responsive. DMX still receives every
      // throttled preview; the React channel display catches up when preview ends.
      if (previewColorRef.current === null) {
        setChannels(next);
      }
      queueSend(next);
    });
  }

  function updateActiveStagePlot2d(plot2d: StagePlotFixture[]) {
    setStages((previous) =>
      previous.map((stage) =>
        stage.id === activeStageId ? { ...stage, plot2d } : stage,
      ),
    );
  }

  function updateActiveStageAudioSource(audio: StageAudioSource | null) {
    setStageAudioSources((previous) => ({
      ...previous,
      [activeStageId]: audio,
    }));
    if (audio?.file) {
      void rememberRecentFile("audio", audio.file);
    }
  }

  useEffect(() => {
    if (!Object.keys(latestTimelineOutputRef.current).length) return;
    const next = buildFixtureChannels(
      latestTimelineOutputRef.current,
      previewColorRef.current,
    );
    setChannels(next);
    queueSend(next);
  }, [fixtures]);

  useEffect(() => () => {
    if (previewUpdateFrameRef.current !== null) {
      cancelAnimationFrame(previewUpdateFrameRef.current);
    }
  }, []);

  async function blackout() {
    const next = Array(512).fill(0);
    setChannels(next);

    try {
      await invoke("blackout");
      setStatus("Blackout sent.");
    } catch (err) {
      setStatus(`Blackout error: ${String(err)}`);
    }
  }

  useEffect(() => {
    refreshPorts();
    const refreshTimer = window.setInterval(refreshPorts, 2500);

    return () => window.clearInterval(refreshTimer);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROGRAM_CUSTOM_MODES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as FixtureMode[];
      if (Array.isArray(parsed)) {
        setProgramCustomModes(
          parsed.filter(
            (mode) =>
              typeof mode?.id === "string" &&
              typeof mode?.name === "string" &&
              Array.isArray(mode?.channels),
          ),
        );
      }
    } catch {
      // Ignore malformed persisted custom fixture modes.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PROGRAM_CUSTOM_MODES_STORAGE_KEY,
        JSON.stringify(programCustomModes),
      );
    } catch {
      // Ignore storage write failures and keep runtime behavior intact.
    }
  }, [programCustomModes]);

  useEffect(() => {
    const currentContent = getCurrentProjectContent();
    setIsDirty(lastSavedContentRef.current !== currentContent);
  }, [fixtures, activeFixtureId, activeStageId, stages, customModes]);

  useEffect(() => {
    setCustomFixtureModes(customFixtureModesForApp);
  }, [customFixtureModesForApp]);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (fileMenuRef.current?.contains(event.target as Node)) return;
      setFileMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [fileMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const primaryModifier = event.ctrlKey || event.metaKey;

      if (primaryModifier && key === "s") {
        event.preventDefault();
        void saveShow(event.shiftKey);
        return;
      }

      if (primaryModifier && key === "n") {
        event.preventDefault();
        void newProject();
        return;
      }

      if (page !== "stage" || !primaryModifier || key !== "z") return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (!stageUndoStackRef.current.length) return;
      event.preventDefault();
      undoStageChange();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, stages, activeStageId]);

  useEffect(() => {
    const title = isDirty
      ? `${documentName} • Unsaved — Disaster`
      : `${documentName} — Disaster`;

    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {
      // Keep the document title fallback even if the native window title update fails.
    });
  }, [documentName, isDirty]);

  useEffect(() => {
    if (autoUpdateCheckedRef.current) return;
    autoUpdateCheckedRef.current = true;
    void checkForUpdates(false);
  }, []);

  return (
    <div
      className={`appShell ${visualEffectsEnabled ? "" : "effectsDisabled"}`}
      style={
        {
          "--app-font-family":
            fontFamily === "system"
              ? "Inter, ui-sans-serif, system-ui, sans-serif"
              : fontFamily,
        } as CSSProperties
      }
    >
      <header className="appHeader">
        <input
          ref={openInputRef}
          type="file"
          accept=".dstr,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void openProjectFromFile(file);
          }}
        />
        <div className="headerStart">
          <button className="brand" onClick={() => setPage("app")}>
            <img className="brandMark brandLogoImage" src={disasterLogo} alt="Disaster logo" />
          </button>
          <div className="fileMenu" ref={fileMenuRef}>
            <button
              className={`fileMenuButton ${fileMenuOpen ? "fileMenuOpen" : ""}`}
              onClick={() => setFileMenuOpen((open) => !open)}
            >
              File
            </button>
            {fileMenuOpen ? (
              <div className="fileMenuPopover">
                <button onClick={() => void openProject()}>Open</button>
                <button onClick={newProject}>New</button>
                <button onClick={() => void saveShow(false)}>Save</button>
                <button onClick={() => void saveShow(true)}>Save As</button>
                <button onClick={() => void checkForUpdates(true)}>
                  {checkingForUpdates ? "Checking for Updates..." : "Check for Updates"}
                </button>
              </div>
            ) : null}
          </div>
          <div className="headerProjectStatus" title={documentName}>
            <strong>{documentName}</strong>
            <span className={isDirty ? "projectDirty" : "projectSaved"}>
              {isDirty ? "Unsaved" : "Saved"}
            </span>
          </div>
        </div>

        <div className="headerCenter">
          <nav className="pageNav" aria-label="Main navigation">
            <button
              className={page === "app" ? "navActive" : ""}
              onClick={() => setPage("app")}
            >
              App
            </button>
            <button
              className={page === "patch" ? "navActive" : ""}
              onClick={() => setPage("patch")}
            >
              Fixtures
            </button>
            <button
              className={page === "timeline" ? "navActive" : ""}
              onClick={() => setPage("timeline")}
            >
              Timeline Editor
            </button>
            <button
              className={page === "stage" ? "navActive" : ""}
              onClick={() => setPage("stage")}
            >
              Stage View
            </button>
          </nav>
        </div>

        <div className="headerControls">
          {updateAvailability === "available" && availableUpdate ? (
            <button
              type="button"
              className="headerUpdateAvailable"
              onClick={openUpdaterSection}
              title={`Disaster ${availableUpdate.version} is available`}
            >
              <span aria-hidden="true">↑</span>
              <strong>Update available</strong>
              <small>{availableUpdate.version}</small>
            </button>
          ) : null}
          <button className="blackoutHeaderButton" onClick={() => void blackout()}>
            Blackout
          </button>
          <div className={`connectionBadge ${connected && liveOutput ? "isLive" : ""}`}>
          <span className="connectionLight" />
          <span>
            <strong>
              {connectionKind === "mixed"
                ? "USB + ART-NET"
                : connectionKind === "artnet" || selectedPort.startsWith("artnet:")
                  ? "ART-NET"
                  : "USB DMX"}
            </strong>
            <small>{connected && liveOutput ? "Connected · Live" : "Offline"}</small>
          </span>
          </div>
        </div>
      </header>

      {page === "app" ? (
      <main className="appInfoPage">
        <section className="appInfoHero">
          <div className="appInfoHeroBrand">
            <img src={disasterLogo} alt="Disaster logo" />
            <div>
              <p className="eyebrow">APPLICATION</p>
              <h1>Disaster</h1>
              <span>DMX timeline programming and show playback</span>
            </div>
          </div>
          <div className="appInfoHeroVersion">
            <small>Current version</small>
            <strong>{displayVersion}</strong>
          </div>
        </section>

        <section className="appRecentGrid">
          <article className="appRecentPanel">
            <div className="appRecentHeader">
              <div>
                <small>RECENTLY OPENED</small>
                <h2>Projects</h2>
              </div>
              <button onClick={() => void openProject()}>Open project</button>
            </div>
            <div className="appRecentList">
              {recentProjects.length ? (
                recentProjects.map((entry) => (
                  <button
                    key={entry.id}
                    className="appRecentItem"
                    onClick={() => void openRecentProject(entry)}
                  >
                    <span className="appRecentFileType">DSTR</span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>
                        {new Date(entry.openedAt).toLocaleString()} ·{" "}
                        {Math.max(1, Math.round(entry.size / 1024))} KB
                      </small>
                    </span>
                    <i>Open</i>
                  </button>
                ))
              ) : (
                <p className="appRecentEmpty">Projects you open will appear here.</p>
              )}
            </div>
          </article>

          <article className="appRecentPanel">
            <div className="appRecentHeader">
              <div>
                <small>RECENTLY OPENED</small>
                <h2>Audio</h2>
              </div>
            </div>
            <div className="appRecentList">
              {recentAudio.length ? (
                recentAudio.map((entry) => (
                  <button
                    key={entry.id}
                    className="appRecentItem"
                    onClick={() => void openRecentAudioFile(entry)}
                  >
                    <span className="appRecentFileType audio">MP3</span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>
                        {new Date(entry.openedAt).toLocaleString()} ·{" "}
                        {(entry.size / (1024 * 1024)).toFixed(1)} MB
                      </small>
                    </span>
                    <i>Load</i>
                  </button>
                ))
              ) : (
                <p className="appRecentEmpty">MP3 files you load will appear here.</p>
              )}
            </div>
          </article>
        </section>

        <section className="appInfoGrid">
          <article className="appInfoCard appAppearanceCard">
            <div className="appInfoCardHeader">
              <div>
                <small>APPEARANCE</small>
                <h2>Interface</h2>
              </div>
            </div>
            <label className="appAppearanceSetting">
              <span>
                <strong>Font family</strong>
                <small>Used throughout the application</small>
              </span>
              <select
                value={fontFamily}
                onChange={(event) => {
                  const next = event.target.value;
                  setFontFamily(next);
                  localStorage.setItem(FONT_FAMILY_STORAGE_KEY, next);
                }}
              >
                <option value="system">System</option>
                <option value="Arial, sans-serif">Arial</option>
                <option value="Helvetica, Arial, sans-serif">Helvetica</option>
                <option value="Verdana, sans-serif">Verdana</option>
                <option value="Georgia, serif">Georgia</option>
                <option value="'Times New Roman', serif">Times New Roman</option>
                <option value="'Courier New', monospace">Courier New</option>
              </select>
            </label>
            <label className="appAppearanceSetting appAppearanceToggle">
              <span>
                <strong>Glow &amp; gradients</strong>
                <small>Graph underglow, shadows, gradients, and illuminated accents</small>
              </span>
              <input
                type="checkbox"
                checked={visualEffectsEnabled}
                onChange={(event) => {
                  const next = event.target.checked;
                  setVisualEffectsEnabled(next);
                  localStorage.setItem(VISUAL_EFFECTS_STORAGE_KEY, String(next));
                }}
              />
            </label>
            <label className="appAppearanceSetting appAppearanceToggle">
              <span>
                <strong>Preview cues on minimized fixtures</strong>
                <small>Show compact intensity, color, transition, and strobe timelines</small>
              </span>
              <input
                type="checkbox"
                checked={minimizedCuePreviewsEnabled}
                onChange={(event) => {
                  const next = event.target.checked;
                  setMinimizedCuePreviewsEnabled(next);
                  localStorage.setItem(
                    MINIMIZED_CUE_PREVIEWS_STORAGE_KEY,
                    String(next),
                  );
                }}
              />
            </label>
          </article>

          <article
            ref={updaterCardRef}
            className="appInfoCard appUpdaterCard"
            tabIndex={-1}
            aria-live="polite"
          >
            <div className="appInfoCardHeader">
              <div>
                <small>UPDATE STATUS</small>
                <h2>Updater</h2>
              </div>
              <button
                className="appInfoActionButton"
                onClick={() => void checkForUpdates(true)}
                disabled={checkingForUpdates || installingUpdate}
              >
                {checkingForUpdates ? "Checking..." : "Check now"}
              </button>
            </div>
            <div className="appUpdaterSummary">
              <div className={`appInfoStatusBadge status-${updateAvailability}`}>
                {updateAvailability === "idle"
                  ? "Not checked yet"
                  : updateAvailability === "checking"
                    ? "Checking"
                    : updateAvailability === "upToDate"
                      ? "Up to date"
                      : updateAvailability === "available"
                        ? "Update available"
                        : updateAvailability === "notConfigured"
                          ? "Not configured"
                          : "Update error"}
              </div>
              <p>{updateStatusDetail}</p>
            </div>
            <div className="appUpdaterChanges">
              <div>
                <small>RECENT CHANGES</small>
                <span>
                  {availableUpdate
                    ? `Version ${availableUpdate.version}`
                    : `Version ${displayVersion}`}
                </span>
              </div>
              <ul>
                {updateChangeList(availableUpdate?.body).map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              {availableUpdate ? (
                <>
                  <div className="appUpdaterMetadata">
                    <span>
                      <small>DOWNLOAD</small>
                      <strong>{formatUpdateSize(availableUpdate.downloadSize)}</strong>
                    </span>
                    <span>
                      <small>PUBLISHED</small>
                      <strong>{availableUpdate.date ?? "Unknown"}</strong>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="appInfoActionButton appUpdaterInstallButton"
                    disabled={installingUpdate}
                    onClick={() => void installAvailableUpdate()}
                  >
                    {installingUpdate ? "Installing..." : "Review and install"}
                  </button>
                </>
              ) : null}
            </div>
          </article>

          <article className="appInfoCard">
            <div className="appInfoCardHeader">
              <div>
                <small>SUPPORTED DEVICES</small>
                <h2>USB DMX + Art-Net</h2>
              </div>
            </div>
            <ul className="appInfoList">
              <li>FTDI-based USB-DMX interfaces</li>
              <li>Generic USB serial DMX devices exposed as COM or tty ports</li>
              <li>Art-Net nodes discovered automatically over UDP</li>
              <li>Live DMX universe output with 512 channels</li>
              <li>USB DMX is preferred automatically when both transports are available</li>
            </ul>
            <div className="appInfoMetaList compact">
              <div>
                <span>Connection</span>
                <strong>{connected ? "Connected" : "Offline"}</strong>
              </div>
              <div>
                <span>Live output</span>
                <strong>{liveOutput ? "Enabled" : "Disabled"}</strong>
              </div>
              <div>
                <span>Selected output</span>
                <strong>
                  {selectedOutputIds.length
                    ? `${selectedOutputIds.length} output${selectedOutputIds.length === 1 ? "" : "s"}${
                        selectedOutputIds.some((id) => id.startsWith("artnet:"))
                          ? ` · Universe ${artNetUniverse}`
                          : ""
                      }`
                    : "None"}
                </strong>
              </div>
            </div>
          </article>

          <article className="appInfoCard">
            <div className="appInfoCardHeader">
              <div>
                <small>FIXTURE SUPPORT</small>
                <h2>Current profiles</h2>
              </div>
            </div>
            <ul className="appInfoList">
              {FIXTURE_MODES.map((mode) => (
                <li key={mode.id}>{mode.name}</li>
              ))}
              <li>Custom fixture types saved to project or program</li>
              <li>Open Fixture Library imports</li>
            </ul>
          </article>
        </section>
      </main>
      ) : page === "patch" ? (
      <main className="container">
      <h1>DMX Timeline</h1>
      <p className="subtitle">USB DMX and Art-Net output</p>

      <section className="card">
        <h2>DMX Output Device</h2>

        <div className="row">
          <button onClick={refreshPorts}>Refresh Ports</button>

          <label className={`artNetEnableToggle ${artNetEnabled ? "enabled" : ""}`}>
            <input
              type="checkbox"
              checked={artNetEnabled}
              onChange={(event) =>
                void setArtNetOutputEnabled(event.target.checked)
              }
            />
            <span>
              <strong>Art-Net</strong>
              <small>{artNetEnabled ? "Discovery on" : "Off"}</small>
            </span>
          </label>

          <div className="dmxOutputChecklist">
            {!ports.length && !artNetNodes.length ? (
              <span className="dmxOutputEmpty">No DMX devices found</span>
            ) : null}
            {ports.map((port) => (
              <label key={port.portName}>
                <input
                  type="checkbox"
                  checked={selectedOutputIds.includes(port.portName)}
                  disabled={connected}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [
                          port.portName,
                          ...selectedOutputIds.filter(
                            (id) =>
                              id.startsWith("artnet:") || id === port.portName,
                          ),
                        ]
                      : selectedOutputIds.filter((id) => id !== port.portName);
                    selectedOutputIdsRef.current = next;
                    setSelectedOutputIds(next);
                    setSelectedPort(next[0] ?? "");
                  }}
                />
                <span>
                  <strong>{getPortLabel(port)}</strong>
                  <small>USB DMX · Preferred</small>
                </span>
              </label>
            ))}
            {artNetEnabled ? artNetNodes.map((node) => {
              const deviceId = getArtNetDeviceId(node);
              return (
                <label key={deviceId}>
                  <input
                    type="checkbox"
                    checked={selectedOutputIds.includes(deviceId)}
                    disabled={connected}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selectedOutputIds, deviceId]
                        : selectedOutputIds.filter((id) => id !== deviceId);
                      selectedOutputIdsRef.current = next;
                      setSelectedOutputIds(next);
                      setSelectedPort(next[0] ?? "");
                    }}
                  />
                  <span>
                    <strong>{getArtNetNodeLabel(node)}</strong>
                    <small>Art-Net</small>
                  </span>
                </label>
              );
            }) : null}
          </div>

          {selectedOutputIds.some((id) => id.startsWith("artnet:")) ? (
            <label className="artNetUniverseControl">
              Universe
              <input
                type="number"
                min="0"
                max="32767"
                value={artNetUniverse}
                disabled={connected}
                onChange={(event) =>
                  setArtNetUniverse(
                    Math.min(32767, Math.max(0, Number(event.target.value))),
                  )
                }
              />
            </label>
          ) : null}

          {!connected ? (
            <button onClick={connect} disabled={!selectedOutputIds.length}>
              Connect
            </button>
          ) : (
            <button onClick={disconnect}>Disconnect</button>
          )}

          <button onClick={blackout}>Blackout</button>

          <label className="liveToggle">
            <input
              type="checkbox"
              checked={liveOutput}
              disabled={!connected}
              onChange={(e) => toggleLiveOutput(e.target.checked)}
            />
            Live output
          </label>


        </div>

        <p className="status">{status}</p>
      </section>

      <section className="card">
        <h2>Fixture Patch List</h2>

        <p>
          Add fixtures to the DMX universe, then select one fixture to control its
          mapped attributes.
        </p>

        <div className="patchGrid">
          <label>
            Fixture name
            <input
              type="text"
              value={draftFixtureName}
              onChange={(e) => setDraftFixtureName(e.target.value)}
            />
          </label>

          <label>
            Start address
            <input
              type="number"
              min="1"
              max="512"
              value={draftStartAddress}
              onChange={(e) => {
                const nextAddress = Number(e.target.value);
                setDraftStartAddress(Math.min(512, Math.max(1, nextAddress)));
              }}
            />
          </label>

          <label>
            Fixture type
            <select
              value={draftFixtureModeId}
              onChange={(e) => setDraftFixtureModeId(e.target.value)}
            >
              {allModes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.name}
                </option>
              ))}
            </select>
          </label>

          <button onClick={addFixture}>Add Fixture</button>
        </div>

        <div className={`customFixtureBuilder ${customFixtureBuilderOpen ? "isOpen" : ""}`}>
          <button
            className="customFixtureBuilderToggle"
            onClick={() => setCustomFixtureBuilderOpen((open) => !open)}
            aria-expanded={customFixtureBuilderOpen}
          >
            <span>
              <strong>Custom fixture type</strong>
              <small>Create and save your own DMX channel layout</small>
            </span>
            <i>{customFixtureBuilderOpen ? "−" : "+"}</i>
          </button>

          {customFixtureBuilderOpen ? (
            <>
              <div className="customFixtureBuilderHeader">
                <div>
                  <h3>Custom fixture type</h3>
                  <p>
                    Build your own channel layout using common DMX attributes, then
                    reuse it anywhere in this project.
                  </p>
                </div>
                <button onClick={createCustomFixtureMode}>Save Fixture Type</button>
              </div>

              <div className="customFixtureScope">
                <span>Save scope</span>
                <div className="customFixtureScopeOptions">
                  <button
                    type="button"
                    className={customModeSaveScope === "project" ? "scopeSelected" : ""}
                    onClick={() => setCustomModeSaveScope("project")}
                  >
                    Save to project
                  </button>
                  <button
                    type="button"
                    className={customModeSaveScope === "program" ? "scopeSelected" : ""}
                    onClick={() => setCustomModeSaveScope("program")}
                  >
                    Save to program
                  </button>
                </div>
                <small>
                  Project saves into this .dstr file. Program stays available across all projects on this machine.
                </small>
              </div>

              <div className="customFixtureBuilderGrid">
                <label>
                  Fixture type name
                  <input
                    type="text"
                    value={customModeName}
                    onChange={(event) => setCustomModeName(event.target.value)}
                    placeholder="Custom fixture name"
                  />
                </label>

                <label>
                  Common channel presets
                  <div className="customChannelAdder">
                    <select
                      value={nextCustomChannel}
                      onChange={(event) => setNextCustomChannel(event.target.value)}
                    >
                      {COMMON_CHANNEL_PRESETS.map((channel) => (
                        <option key={channel} value={channel}>
                          {channel}
                        </option>
                      ))}
                    </select>
                    <button onClick={addCustomChannel}>Add Channel</button>
                  </div>
                </label>
              </div>

              <div className="customChannelList">
                {customModeChannels.map((channel, index) => (
                  <div key={`${channel}-${index}`} className="customChannelRow">
                    <span>CH {index + 1}</span>
                    <select
                      value={channel}
                      onChange={(event) =>
                        updateCustomChannel(index, event.target.value)
                      }
                    >
                      {COMMON_CHANNEL_PRESETS.map((preset) => (
                        <option key={preset} value={preset}>
                          {preset}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={channel}
                      onChange={(event) =>
                        updateCustomChannel(index, event.target.value)
                      }
                      placeholder="Custom channel label"
                    />
                    <button onClick={() => removeCustomChannel(index)}>Remove</button>
                  </div>
                ))}
              </div>

              {customFixtureModesForApp.length ? (
                <div className="savedCustomModes">
                  <div className="savedCustomModesHeader">
                    <strong>Saved custom fixture types</strong>
                    <span>{customFixtureModesForApp.length}</span>
                  </div>
                  <div className="savedCustomModesList">
                    {customFixtureModesForApp.map((mode) => (
                      <div key={mode.id} className="savedCustomModeRow">
                        <div>
                          <strong>
                            {mode.name}
                            <small>
                              {programCustomModes.some((item) => item.id === mode.id)
                                ? "Program"
                                : "Project"}
                            </small>
                          </strong>
                          <span>{mode.channels.length} channels</span>
                        </div>
                        <button onClick={() => removeCustomFixtureMode(mode.id)}>
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="fixtureLibrarySearch">
          <label>
            Search Open Fixture Library
            <input
              type="search"
              placeholder="Search manufacturer or fixture"
              value={fixtureSearchQuery}
              onFocus={() => void loadOflIndex()}
              onChange={(event) => {
                setFixtureSearchQuery(event.target.value);
                if (!oflIndex.length) void loadOflIndex();
              }}
            />
          </label>
          {oflLoading ? <span>Loading fixture library…</span> : null}
          {oflError ? <span className="warning">{oflError}</span> : null}
        </div>
        {filteredOflFixtures.length ? (
          <div className="fixtureSearchResults">
            {filteredOflFixtures.map((entry) => (
              <button
                key={`${entry.manufacturerKey}/${entry.fixtureKey}`}
                className="fixtureSearchResult"
                onClick={() => void importOflFixture(entry)}
              >
                <strong>{entry.fixtureName}</strong>
                <span>{entry.manufacturerName}</span>
              </button>
            ))}
          </div>
        ) : null}

        <section className="currentFixturesSection">
          <div className="currentFixturesHeader">
            <div>
              <small>PATCHED TO THIS PROJECT</small>
              <h3>Current fixtures</h3>
            </div>
            <span>{fixtures.length} fixture{fixtures.length === 1 ? "" : "s"}</span>
          </div>

          <div className="fixtureList">
            {fixtures.map((fixture) => {
            const mode = getFixtureMode(fixture.modeId);
            const endAddress = getFixtureEndAddress(fixture);
            const isActive = fixture.id === activeFixtureId;

            return (
              <div
                key={fixture.id}
                className={`fixtureListItem ${isActive ? "activeFixture" : ""} ${patchFixtureDropTarget === fixture.id ? "fixtureDropTarget" : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                onClick={() => setActiveFixtureId(fixture.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveFixtureId(fixture.id);
                  }
                }}
                onDragOver={(event) => {
                  if (!draggedPatchFixtureId || draggedPatchFixtureId === fixture.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setPatchFixtureDropTarget(fixture.id);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setPatchFixtureDropTarget((current) =>
                      current === fixture.id ? null : current,
                    );
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedId =
                    draggedPatchFixtureId || event.dataTransfer.getData("text/plain");
                  if (draggedId) {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    reorderPatchedFixture(
                      draggedId,
                      fixture.id,
                      event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before",
                    );
                  }
                  setDraggedPatchFixtureId(null);
                  setPatchFixtureDropTarget(null);
                }}
              >
                <span
                  className="fixtureDragHandle"
                  draggable
                  title={`Drag to reorder ${fixture.name}`}
                  aria-label={`Drag to reorder ${fixture.name}`}
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", fixture.id);
                    setDraggedPatchFixtureId(fixture.id);
                  }}
                  onDragEnd={() => {
                    setDraggedPatchFixtureId(null);
                    setPatchFixtureDropTarget(null);
                  }}
                >
                  {String.fromCharCode(0x28ff)}
                </span>
                <div>
                  <strong>{fixture.name}</strong>
                  <span>
                    {mode.name} — DMX {fixture.startAddress} to {endAddress}
                  </span>
                </div>

                <label
                  className="fixtureAddress"
                  onClick={(event) => event.stopPropagation()}
                >
                  Start address
                  <input
                    type="number"
                    min="1"
                    max={512 - getModeChannelCount(mode) + 1}
                    value={fixture.startAddress}
                    onChange={(event) =>
                      updateFixtureStartAddress(
                        fixture.id,
                        Number(event.target.value),
                      )
                    }
                  />
                </label>

                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    clearFixture(fixture);
                  }}
                >
                  Clear
                </button>

                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteFixture(fixture.id);
                  }}
                >
                  Delete
                </button>
              </div>
            );
            })}
          </div>
        </section>
      </section>

      <section className="card">
        <h2>Active Fixture Control</h2>

        {!activeFixture ? (
          <p>No fixture selected. Add a fixture above.</p>
        ) : (
          <>
            <div className="fixtureSummary">
              <strong>{activeFixture.name}</strong>
              <span>
                {activeFixtureMode.name}, DMX address {activeFixture.startAddress}
              </span>
            </div>

            {activeFixtureMode.channels.map((fixtureChannel) => {
              const actualChannelNumber =
                activeFixture.startAddress + fixtureChannel.offset;
              const index = actualChannelNumber - 1;

              if (actualChannelNumber > 512) {
                return (
                  <p key={fixtureChannel.label} className="warning">
                    {fixtureChannel.label} is outside the 512-channel DMX universe.
                  </p>
                );
              }

              return (
                <DmxSlider
                  key={`${activeFixture.id}-${fixtureChannel.label}`}
                  label={`${fixtureChannel.label} — DMX Ch ${actualChannelNumber}`}
                  value={channels[index]}
                  onChange={(value) => updateChannel(actualChannelNumber, value)}
                />
              );
            })}
          </>
        )}
      </section>

      <section className="card">
        <UniverseGrid
          fixtures={fixtures}
          activeFixtureId={activeFixtureId}
          channels={channels}
        />
      </section>

      </main>
      ) : page === "timeline" ? (
        <TimelineEditor
          key={`${projectSessionKey}:${activeStage?.id ?? "stage-1"}`}
          fixtures={fixtures}
          onOutputFrame={applyTimelineFrame}
          onColorPreviewChange={handleColorPreviewChange}
          onDocumentStateChange={updateActiveStageTimeline}
          onAudioSourceChange={updateActiveStageAudioSource}
          initialAudioSourceUrl={stageAudioSources[activeStage?.id ?? "stage-1"]?.url ?? null}
          requestedAudioFile={requestedAudioFile}
          onRequestedAudioHandled={() => setRequestedAudioFile(null)}
          initialDocumentState={activeStage?.timeline ?? null}
          initialHistoryState={stageTimelineHistories[activeStage?.id ?? "stage-1"] ?? null}
          stagePlacements={activeStage?.plot2d ?? []}
          stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
          activeStageId={activeStage?.id ?? "stage-1"}
          onSelectStage={setActiveStageId}
          onAddStage={addStage}
          onRenameStage={renameStage}
          onRemoveStage={removeStage}
          volume={sharedVolume}
          onVolumeChange={setSharedVolume}
          onHistoryStateChange={updateActiveStageTimelineHistory}
          previewMinimizedCues={minimizedCuePreviewsEnabled}
        />
      ) : (
        <StageView
          mode={stageViewMode}
          onChangeMode={setStageViewMode}
          fixtures={fixtures}
          stage={activeStage ?? null}
          audioSource={stageAudioSources[activeStage?.id ?? "stage-1"] ?? null}
          stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
          activeStageId={activeStage?.id ?? "stage-1"}
          onSelectStage={setActiveStageId}
          onAddStage={addStage}
          onRenameStage={renameStage}
          onRemoveStage={removeStage}
          volume={sharedVolume}
          onVolumeChange={setSharedVolume}
          onUpdatePlot2d={updateActiveStagePlot2d}
          onBeforePlotChange={pushStageUndoSnapshot}
        />
      )}
    </div>
  );
}

function UniverseGrid({
  fixtures,
  activeFixtureId,
  channels,
}: {
  fixtures: PatchedFixture[];
  activeFixtureId: string;
  channels: number[];
}) {
  const palette = ["#3185ff", "#e348b8", "#f2a93b", "#55ba74", "#8b6ee8"];
  const [hoveredChannel, setHoveredChannel] = useState<{
    address: number;
    fixtureName: string;
    modeName: string;
    range: string;
    channelLabel: string;
    value: number;
  } | null>(null);
  return (
    <div className="universePanel">
      <div className="universeHeading">
        <div>
          <strong>DMX Universe</strong>
          <span>512 channel patch overview</span>
        </div>
        <div className="universeMeta">
          <div
            className={`universeHoverCard ${hoveredChannel ? "isVisible" : ""}`}
            aria-hidden={!hoveredChannel}
          >
            <strong>{hoveredChannel?.fixtureName ?? "Channel details"}</strong>
            <span>
              {hoveredChannel
                ? `DMX ${hoveredChannel.address} · ${hoveredChannel.channelLabel} · Value ${hoveredChannel.value} · ${hoveredChannel.range} · ${hoveredChannel.modeName}`
                : "Hover over a patched channel"}
            </span>
          </div>
          <span>{fixtures.reduce((total, fixture) => total + getModeChannelCount(getFixtureMode(fixture.modeId)), 0)} channels used</span>
        </div>
      </div>
      <div className="universeGrid">
        {Array.from({ length: 512 }, (_, index) => {
          const address = index + 1;
          const fixtureIndex = fixtures.findIndex(
            (fixture) => address >= fixture.startAddress && address <= getFixtureEndAddress(fixture),
          );
          const fixture = fixtures[fixtureIndex];
          const mode = fixture ? getFixtureMode(fixture.modeId) : null;
          const fixtureChannel = fixture && mode
            ? mode.channels.find(
                (channel) => fixture.startAddress + channel.offset === address,
              )
            : null;
          const liveValue = channels[index] ?? 0;
          return (
            <button
              key={address}
              className={`${fixture ? "occupiedChannel" : ""} ${fixture?.id === activeFixtureId ? "activeChannel" : ""}`}
              style={fixture ? { "--fixture-color": palette[fixtureIndex % palette.length] } as CSSProperties : undefined}
              title={
                fixture
                  ? `DMX ${address}: ${fixture.name} · ${fixtureChannel?.label ?? "Channel"} · Value ${liveValue}`
                  : `DMX ${address}: Unpatched · Value ${liveValue}`
              }
              onMouseEnter={() =>
                setHoveredChannel(
                  fixture
                    ? {
                        address,
                        fixtureName: fixture.name,
                        modeName: mode?.name ?? "",
                        range: `${fixture.startAddress}-${getFixtureEndAddress(fixture)}`,
                        channelLabel: fixtureChannel?.label ?? "Channel",
                        value: liveValue,
                      }
                    : null,
                )
              }
              onMouseLeave={() => setHoveredChannel(null)}
            >
              <strong className="channelValue">{liveValue}</strong>
              <span className="channelAddress">{address}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function clockLabel(time: number) {
  return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}.${Math.floor((time % 1) * 10)}`;
}

function getStagePreviewOutput(
  fixtures: PatchedFixture[],
  timeline: TimelineDocumentData | null,
  playhead: number,
) {
  const output: Record<
    string,
    { intensity: number; color: string | null; strobe: number | null }
  > = {};
  const tracks = timeline?.tracks ?? {};

  fixtures.forEach((fixture) => {
    const data = tracks[fixture.id];
    if (!data) {
      output[fixture.id] = { intensity: 0, color: null, strobe: null };
      return;
    }

    const points = [...data.points].sort((a, b) => a.time - b.time);
    const afterIndex = points.findIndex((point) => point.time >= playhead);
    const after = afterIndex < 0 ? points[points.length - 1] : points[afterIndex];
    const before = afterIndex <= 0 ? points[0] : points[afterIndex - 1];
    const progress =
      before && after && after.time !== before.time
        ? (playhead - before.time) / (after.time - before.time)
        : 0;
    const intensity =
      before && after
        ? before.value + (after.value - before.value) * Math.min(1, Math.max(0, progress))
        : 0;
    const activeTransition =
      [...(data.colorTransitions ?? [])]
        .reverse()
        .find(
          (transition) =>
            playhead >= transition.start &&
            playhead < transition.start + transition.duration,
        ) ?? null;
    const solidColor =
      [...data.colors]
        .reverse()
        .find((clip) => playhead >= clip.start && playhead < clip.start + clip.duration)?.color ??
      null;
    const color = activeTransition
      ? interpolateHexColor(
          activeTransition.fromColor,
          activeTransition.toColor,
          (playhead - activeTransition.start) / Math.max(0.001, activeTransition.duration),
        )
      : solidColor;
    const strobe =
      [...data.strobes]
        .reverse()
        .find((clip) => playhead >= clip.start && playhead < clip.start + clip.duration)?.rate ??
      null;

    output[fixture.id] = { intensity, color, strobe };
  });

  return output;
}

function getMiniIntensityPath(points: Array<{ time: number; value: number }>, duration: number) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (!sorted.length) return "";
  return sorted
    .map((point, index) => {
      const x = duration > 0 ? (point.time / duration) * 100 : 0;
      const y = 100 - point.value * 100;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function StageView({
  mode,
  onChangeMode,
  fixtures,
  stage,
  audioSource,
  stages,
  activeStageId,
  onSelectStage,
  onAddStage,
  onRenameStage,
  onRemoveStage,
  volume,
  onVolumeChange,
  onUpdatePlot2d,
  onBeforePlotChange,
}: {
  mode: "hub" | "plot2d";
  onChangeMode: (mode: "hub" | "plot2d") => void;
  fixtures: PatchedFixture[];
  stage: StageDocument | null;
  audioSource: StageAudioSource | null;
  stages: Array<{ id: string; name: string }>;
  activeStageId: string;
  onSelectStage: (stageId: string) => void;
  onAddStage: () => void;
  onRenameStage: (stageId: string) => void;
  onRemoveStage: (stageId: string) => void;
  volume: number;
  onVolumeChange: (volume: number) => void;
  onUpdatePlot2d: (plot2d: StagePlotFixture[]) => void;
  onBeforePlotChange: () => void;
}) {
  const timeline = stage?.timeline ?? null;
  const duration = Math.max(10, timeline?.duration ?? 60);
  const waveform = timeline?.waveform?.length
    ? timeline.waveform
    : Array.from({ length: 180 }, (_, index) =>
        0.15 + Math.abs(Math.sin(index * 0.41) * Math.cos(index * 0.13)) * 0.7,
      );
  const plotFixtures = stage?.plot2d ?? [];
  const [playhead, setPlayhead] = useState(timeline?.playhead ?? 0);
  const [playing, setPlaying] = useState(false);
  const [transportLockEnabled, setTransportLockEnabled] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [plotGridSize, setPlotGridSize] = useState(8);
  const [plotZoom, setPlotZoom] = useState(() => {
    const saved = Number(window.localStorage.getItem(STAGE_PLOT_ZOOM_STORAGE_KEY));
    return Number.isFinite(saved) && saved >= 0.7 && saved <= 1.8 ? saved : 1;
  });
  const [plotViewportOffset, setPlotViewportOffset] = useState({ x: 0, y: 0 });
  const [selectedFixtureForPlot, setSelectedFixtureForPlot] = useState(
    fixtures[0]?.id ?? "",
  );
  const [selectedFixtureIdsForPlot, setSelectedFixtureIdsForPlot] = useState<string[]>(
    fixtures[0]?.id ? [fixtures[0].id] : [],
  );
  const plotViewportRef = useRef<HTMLDivElement>(null);
  const stageFrameRef = useRef<HTMLDivElement>(null);
  const plotPanRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const plotSelectionRef = useRef<{
    pointerId: number;
    additive: boolean;
    anchorX: number;
    anchorY: number;
  } | null>(null);
  const fixtureDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    historyCaptured: boolean;
  } | null>(null);
  const [plotSelectionBox, setPlotSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadedStageAudioRef = useRef<string | null>(null);
  const previewOutput = getStagePreviewOutput(fixtures, timeline, playhead);
  const selectedPlacedFixtures = plotFixtures.filter((item) =>
    selectedFixtureIdsForPlot.includes(item.fixtureId),
  );
  const selectedPlotDirection =
    selectedPlacedFixtures.length === 0
      ? ""
      : selectedPlacedFixtures.every(
            (fixture) => fixture.direction === selectedPlacedFixtures[0]?.direction,
          )
        ? (selectedPlacedFixtures[0]?.direction ?? "front")
        : "";
  const stageGridRows = Math.max(4, plotGridSize);
  const stageGridColumns = Math.max(6, Math.round(plotGridSize * 1.5));
  const plotCanvasWidth = 1180;
  const plotCanvasHeight = 760;

  useEffect(() => {
    setPlayhead(timeline?.playhead ?? 0);
    setPlaying(false);
    setStopArmed(false);
  }, [stage?.id, timeline?.playhead]);

  useEffect(() => {
    if (!fixtures.some((fixture) => fixture.id === selectedFixtureForPlot)) {
      setSelectedFixtureForPlot(fixtures[0]?.id ?? "");
    }
  }, [fixtures, selectedFixtureForPlot]);

  useEffect(() => {
    setSelectedFixtureIdsForPlot((previous) => {
      const filtered = previous.filter((fixtureId) =>
        fixtures.some((fixture) => fixture.id === fixtureId),
      );
      if (filtered.length) return filtered;
      return fixtures[0]?.id ? [fixtures[0].id] : [];
    });
  }, [fixtures]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio?.src) {
        setPlayhead(audio.currentTime);
        if (audio.ended) setPlaying(false);
      } else {
        setPlayhead((current) => (current >= duration ? 0 : Math.min(duration, current + 0.05)));
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, duration]);

  useEffect(() => {
    if (!audioRef.current) return;
    if (!audioSource?.url) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      loadedStageAudioRef.current = null;
      return;
    }
    if (
      loadedStageAudioRef.current !== audioSource.url ||
      audioRef.current.src !== audioSource.url
    ) {
      audioRef.current.src = audioSource.url;
      audioRef.current.volume = volume;
      audioRef.current.muted = false;
      audioRef.current.load();
      loadedStageAudioRef.current = audioSource.url;
    }
  }, [audioSource, volume]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
    audioRef.current.muted = false;
  }, [volume]);

  function waitForStageAudioMetadata(audio: HTMLAudioElement) {
    if (audio.readyState >= 1) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const handleLoaded = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Audio failed to load."));
      };
      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", handleLoaded);
        audio.removeEventListener("error", handleError);
      };
      audio.addEventListener("loadedmetadata", handleLoaded, { once: true });
      audio.addEventListener("error", handleError, { once: true });
    });
  }

  useEffect(() => {
    const handleStageSpacebar = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      if (transportLockEnabled) return;
      void toggleStagePlayback();
    };
    window.addEventListener("keydown", handleStageSpacebar);
    return () => window.removeEventListener("keydown", handleStageSpacebar);
  }, [transportLockEnabled, playing, playhead, audioSource]);

  async function toggleStagePlayback() {
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
      await waitForStageAudioMetadata(audio);
      audio.currentTime = Math.min(
        playhead,
        Number.isFinite(audio.duration) ? audio.duration || playhead : playhead,
      );
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

  function snapPlacement(value: number, divisions: number, min: number, max: number) {
    const clamped = Math.min(max, Math.max(min, value));
    return Math.min(max, Math.max(min, Math.round(clamped * divisions) / divisions));
  }

  function setFixturePlacement(fixtureId: string, x: number, y: number) {
    const existing = plotFixtures.find((item) => item.fixtureId === fixtureId);
    const clamped = {
      fixtureId,
      x: snapPlacement(x, stageGridColumns, 0.04, 0.96),
      y: snapPlacement(y, stageGridRows, 0.08, 0.92),
      direction: existing?.direction ?? "front",
    };
    const next = plotFixtures.some((item) => item.fixtureId === fixtureId)
      ? plotFixtures.map((item) => (item.fixtureId === fixtureId ? clamped : item))
      : [...plotFixtures, clamped];
    onUpdatePlot2d(next);
  }

  function updateFixtureDirection(
    fixtureIds: string[],
    direction: "front" | "back" | "left" | "right",
  ) {
    const targetIds = new Set(fixtureIds);
    const next = plotFixtures.map((item) =>
      targetIds.has(item.fixtureId) ? { ...item, direction } : item,
    );
    onUpdatePlot2d(next);
  }

  function getStageSelectionFromClientPoints(
    startClientX: number,
    startClientY: number,
    endClientX: number,
    endClientY: number,
  ) {
    const bounds = stageFrameRef.current?.getBoundingClientRect();
    const frame = stageFrameRef.current;
    if (!bounds || !frame) return { fixtureIds: [], box: null };

    const logicalWidth = frame.clientWidth;
    const logicalHeight = frame.clientHeight;
    const toLogicalX = (value: number) =>
      ((value - bounds.left) / Math.max(1, bounds.width)) * logicalWidth;
    const toLogicalY = (value: number) =>
      ((value - bounds.top) / Math.max(1, bounds.height)) * logicalHeight;
    const clampX = (value: number) =>
      Math.min(logicalWidth, Math.max(0, toLogicalX(value)));
    const clampY = (value: number) =>
      Math.min(logicalHeight, Math.max(0, toLogicalY(value)));
    const startX = clampX(startClientX);
    const startY = clampY(startClientY);
    const endX = clampX(endClientX);
    const endY = clampY(endClientY);
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);
    const minimumSize = 6;
    const fixtureIds = plotFixtures
      .filter((fixture) => {
        const fixtureX = fixture.x * logicalWidth;
        const fixtureY = fixture.y * logicalHeight;
        return (
          fixtureX >= left &&
          fixtureX <= right &&
          fixtureY >= top &&
          fixtureY <= bottom
        );
      })
      .map((fixture) => fixture.fixtureId);

    return {
      fixtureIds,
      box:
        Math.abs(right - left) >= minimumSize || Math.abs(bottom - top) >= minimumSize
          ? {
              left,
              top,
              width: Math.max(minimumSize, right - left),
              height: Math.max(minimumSize, bottom - top),
            }
          : null,
    };
  }

  function placeFixtureAtClientPosition(
    fixtureId: string,
    clientX: number,
    clientY: number,
  ) {
    const bounds = stageFrameRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setFixturePlacement(
      fixtureId,
      (clientX - bounds.left) / bounds.width,
      (clientY - bounds.top) / bounds.height,
    );
  }

  function clampPlotViewportOffset(nextX: number, nextY: number) {
    const viewportWidth = plotViewportRef.current?.clientWidth ?? 0;
    const viewportHeight = plotViewportRef.current?.clientHeight ?? 0;
    const scaledWidth = plotCanvasWidth * plotZoom;
    const scaledHeight = plotCanvasHeight * plotZoom;
    const maxX = Math.max(0, (scaledWidth - viewportWidth) / 2 + 28);
    const maxY = Math.max(0, (scaledHeight - viewportHeight) / 2 + 28);
    return {
      x: Math.max(-maxX, Math.min(maxX, nextX)),
      y: Math.max(-maxY, Math.min(maxY, nextY)),
    };
  }

  useEffect(() => {
    setPlotViewportOffset((current) => clampPlotViewportOffset(current.x, current.y));
  }, [plotZoom]);

  function handleStagePlotWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const direction = Math.sign(event.deltaY);
    if (direction === 0) return;
    setPlotZoom((current) => Math.min(1.8, Math.max(0.7, current - direction * 0.08)));
  }

  function setStagePlayheadFromClientX(clientX: number, bounds: DOMRect) {
    const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    const nextTime = ratio * duration;
    setPlayhead(nextTime);
    if (audioRef.current?.src) {
      audioRef.current.currentTime = nextTime;
    }
  }

  if (mode === "hub") {
    return (
      <main className="stageComingSoon">
        <p className="eyebrow">VISUALIZATION</p>
        <h1>Stage View</h1>
        <div className="stageTabs">
          {stages.map((stageTab) => (
            <div
              key={stageTab.id}
              className={`stageTab ${stageTab.id === activeStageId ? "stageTabActive" : ""}`}
            >
              <button onClick={() => onSelectStage(stageTab.id)}>{stageTab.name}</button>
              <span
                className="stageTabEdit"
                onClick={() => onRenameStage(stageTab.id)}
                title="Rename stage"
              >
                ✎
              </span>
              <span
                className="stageTabRemove"
                onClick={() => onRemoveStage(stageTab.id)}
                title="Remove stage"
              >
                ×
              </span>
            </div>
          ))}
          <button className="addStageButton" onClick={onAddStage}>+ Stage</button>
        </div>
        <p>Build and preview your rig spatially.</p>
        <div className="stageCards">
          <button className="stageCardButton" onClick={() => onChangeMode("plot2d")}>
            <span>2D</span>
            <strong>2D Stage Plot</strong>
            <small>Open visualizer</small>
          </button>
          <article><span>3D</span><strong>3D Visualizer</strong><small>Coming soon</small></article>
        </div>
      </main>
    );
  }

  return (
    <main className={`stagePlotPage ${transportLockEnabled ? "transportLockedScreen" : ""}`}>
      <div className="stagePlotToolbar">
        <div className="stagePlotStart">
          <button className="stageBackButton" onClick={() => onChangeMode("hub")}>
            ← Back
          </button>
          <div className="stagePlotHeading">
            <p className="eyebrow">VISUALIZATION</p>
            <div className="stagePlotTitleRow">
              <h1>2D Stage Plot</h1>
              <div className="stageTabs stageTabsCompact">
              {stages.map((stageTab) => (
                <div
                  key={stageTab.id}
                  className={`stageTab ${stageTab.id === activeStageId ? "stageTabActive" : ""}`}
                >
                  <button onClick={() => onSelectStage(stageTab.id)}>{stageTab.name}</button>
                  <span
                    className="stageTabEdit"
                    onClick={() => onRenameStage(stageTab.id)}
                    title="Rename stage"
                  >
                    ✎
                  </span>
                  <span
                    className="stageTabRemove"
                    onClick={() => onRemoveStage(stageTab.id)}
                    title="Remove stage"
                  >
                    ×
                  </span>
                </div>
              ))}
                <button className="addStageButton" onClick={onAddStage}>+ Stage</button>
              </div>
            </div>
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
              onClick={() => void toggleStagePlayback()}
              onDoubleClick={() => {
                if (!transportLockEnabled) return;
                setTransportLockEnabled(false);
                setStopArmed(false);
              }}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <button onClick={() => setPlayhead((value) => Math.min(duration, value + 5))}>▶|</button>
            <strong>{clockLabel(playhead)}</strong>
            <label className="volumeControl" title="Volume">🔊
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => onVolumeChange(Number(event.target.value))}
              />
            </label>
          </div>
        </div>
        <div className="stagePlotMeta">
          <label className="stagePlotMetaControl">
            Grid size
            <select
              value={plotGridSize}
              onChange={(event) => setPlotGridSize(Number(event.target.value))}
            >
              <option value={6}>Small</option>
              <option value={8}>Medium</option>
              <option value={10}>Large</option>
              <option value={12}>XL</option>
            </select>
          </label>
          <label className="stagePlotMetaControl stagePlotZoomControl">
            Plot zoom
            <input
              type="range"
              min="0.7"
              max="1.8"
              step="0.05"
              value={plotZoom}
              onChange={(event) => {
                const nextZoom = Number(event.target.value);
                setPlotZoom(nextZoom);
                window.localStorage.setItem(STAGE_PLOT_ZOOM_STORAGE_KEY, String(nextZoom));
              }}
            />
            <span>{Math.round(plotZoom * 100)}%</span>
          </label>
          <div className="stagePlotMetaSummary">
            <strong>{stage?.name ?? "Stage"}</strong>
            <span>{fixtures.length} fixtures</span>
          </div>
        </div>
      </div>

      {transportLockEnabled ? <div className="transportLockOverlay" /> : null}

      <div className="stagePlotWorkspace">
        <aside className="stageFixtureShelf">
          <div className="libraryTitle"><span>FIXTURES</span></div>
          <div className="stageFixtureList">
            {fixtures.map((fixture) => {
              const state = previewOutput[fixture.id] ?? {
                intensity: 0,
                color: null,
                strobe: null,
              };
              return (
                <button
                  key={fixture.id}
                  className={`stageFixtureChip ${selectedFixtureIdsForPlot.includes(fixture.id) ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedFixtureForPlot(fixture.id);
                    setSelectedFixtureIdsForPlot([fixture.id]);
                  }}
                  style={{
                    borderColor: state.color ?? "#313944",
                    boxShadow: state.strobe ? "0 0 0 1px rgba(255,255,255,.18), 0 0 16px rgba(255,255,255,.1)" : undefined,
                  }}
                >
                  <strong>{fixture.name}</strong>
                  <span>{getFixtureMode(fixture.modeId).name}</span>
                </button>
              );
            })}
          </div>
          <div className="stageFixtureControls">
            <label>
              Rotation / projection direction
              <select
                value={selectedPlotDirection}
                disabled={!selectedPlacedFixtures.length}
                onChange={(event) =>
                  {
                    onBeforePlotChange();
                    updateFixtureDirection(
                      selectedPlacedFixtures.map((fixture) => fixture.fixtureId),
                      event.target.value as "front" | "back" | "left" | "right",
                    );
                  }
                }
              >
                <option value="" disabled>
                  Mixed
                </option>
                <option value="front">Front</option>
                <option value="back">Back</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
            <small>
              {selectedPlacedFixtures.length
                ? `Controls the direction of ${selectedPlacedFixtures.length === 1 ? "the selected fixture's cone." : "all selected fixtures' cones."}`
                : "Place and select fixtures on the stage to set their cone direction."}
            </small>
          </div>
        </aside>

        <section className="stagePlotCenter">
          <div
            ref={plotViewportRef}
            className="stagePlotViewport"
            onWheel={handleStagePlotWheel}
            onPointerDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest(".stageFixtureBlock")) return;
              if ((event.ctrlKey || event.metaKey) && stageFrameRef.current) {
                const selection = getStageSelectionFromClientPoints(
                  event.clientX,
                  event.clientY,
                  event.clientX,
                  event.clientY,
                );
                plotSelectionRef.current = {
                  pointerId: event.pointerId,
                  additive: true,
                  anchorX: event.clientX,
                  anchorY: event.clientY,
                };
                setPlotSelectionBox(selection.box);
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
                return;
              }
              setSelectedFixtureIdsForPlot([]);
              plotPanRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: plotViewportOffset.x,
                originY: plotViewportOffset.y,
                moved: false,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const selection = plotSelectionRef.current;
              if (
                selection &&
                selection.pointerId === event.pointerId &&
                event.currentTarget.hasPointerCapture(event.pointerId)
              ) {
                const nextSelection = getStageSelectionFromClientPoints(
                  selection.anchorX,
                  selection.anchorY,
                  event.clientX,
                  event.clientY,
                );
                setPlotSelectionBox(nextSelection.box);
                return;
              }
              const pan = plotPanRef.current;
              if (!pan || pan.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) {
                return;
              }
              const deltaX = event.clientX - pan.startX;
              const deltaY = event.clientY - pan.startY;
              if (Math.hypot(deltaX, deltaY) > 4) {
                pan.moved = true;
              }
              setPlotViewportOffset(
                clampPlotViewportOffset(
                  pan.originX + deltaX,
                  pan.originY + deltaY,
                ),
              );
            }}
            onPointerUp={(event) => {
              const selection = plotSelectionRef.current;
              if (
                selection &&
                selection.pointerId === event.pointerId &&
                event.currentTarget.hasPointerCapture(event.pointerId)
              ) {
                const nextSelection = getStageSelectionFromClientPoints(
                  selection.anchorX,
                  selection.anchorY,
                  event.clientX,
                  event.clientY,
                );
                if (nextSelection.fixtureIds.length) {
                  setSelectedFixtureIdsForPlot((previous) =>
                    Array.from(new Set([...previous, ...nextSelection.fixtureIds])),
                  );
                  setSelectedFixtureForPlot(nextSelection.fixtureIds[0] ?? selectedFixtureForPlot);
                }
                setPlotSelectionBox(null);
                plotSelectionRef.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
                return;
              }
              const pan = plotPanRef.current;
              if (
                pan &&
                pan.pointerId === event.pointerId &&
                !pan.moved &&
                selectedFixtureForPlot &&
                !plotFixtures.some((fixture) => fixture.fixtureId === selectedFixtureForPlot)
              ) {
                const bounds = stageFrameRef.current?.getBoundingClientRect();
                if (
                  bounds &&
                  event.clientX >= bounds.left &&
                  event.clientX <= bounds.right &&
                  event.clientY >= bounds.top &&
                  event.clientY <= bounds.bottom
                ) {
                  onBeforePlotChange();
                  placeFixtureAtClientPosition(
                    selectedFixtureForPlot,
                    event.clientX,
                    event.clientY,
                  );
                }
              }
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              plotPanRef.current = null;
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              setPlotSelectionBox(null);
              plotSelectionRef.current = null;
              plotPanRef.current = null;
            }}
          >
            <div
              className="danceStageGrid"
              style={{
                transform: `translate(calc(-50% + ${plotViewportOffset.x}px), calc(-50% + ${plotViewportOffset.y}px)) scale(${plotZoom})`,
              }}
            >
              <div
                ref={stageFrameRef}
                className="danceStageFrame"
                style={
                  {
                    "--stage-grid-columns": String(stageGridColumns),
                    "--stage-grid-rows": String(stageGridRows),
                    width: `${plotCanvasWidth}px`,
                    height: `${plotCanvasHeight}px`,
                  } as React.CSSProperties
                }
              >
                <span className="stageDirectionLabel stageDirectionFront">FRONT</span>
                <span className="stageDirectionLabel stageDirectionBack">BACK</span>
                <span className="stageDirectionLabel stageDirectionLeft">LEFT</span>
                <span className="stageDirectionLabel stageDirectionRight">RIGHT</span>
                {plotSelectionBox ? (
                  <div
                    className="stageFixtureSelectionBox"
                    style={{
                      left: `${plotSelectionBox.left}px`,
                      top: `${plotSelectionBox.top}px`,
                      width: `${plotSelectionBox.width}px`,
                      height: `${plotSelectionBox.height}px`,
                    }}
                  />
                ) : null}
                {plotFixtures.map((placed) => {
                  const fixture = fixtures.find((item) => item.id === placed.fixtureId);
                  if (!fixture) return null;
                  const state = previewOutput[fixture.id] ?? {
                    intensity: 0,
                    color: null,
                    strobe: null,
                  };
                  const tint = state.color ?? "#8ab6ff";
                  const beamDirection = placed.direction ?? "front";
                  return (
                    <button
                      key={fixture.id}
                      className={`stageFixtureBlock ${selectedFixtureIdsForPlot.includes(fixture.id) ? "selected" : ""} ${state.strobe ? "isStrobing" : ""}`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedFixtureForPlot(fixture.id);
                        setSelectedFixtureIdsForPlot((previous) =>
                          event.ctrlKey || event.metaKey
                            ? previous.includes(fixture.id)
                              ? previous.filter((id) => id !== fixture.id)
                              : [...previous, fixture.id]
                            : [fixture.id],
                        );
                        fixtureDragRef.current = {
                          pointerId: event.pointerId,
                          startX: event.clientX,
                          startY: event.clientY,
                          historyCaptured: false,
                        };
                        const target = event.currentTarget;
                        target.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                        const drag = fixtureDragRef.current;
                        if (
                          drag &&
                          drag.pointerId === event.pointerId &&
                          !drag.historyCaptured &&
                          Math.hypot(
                            event.clientX - drag.startX,
                            event.clientY - drag.startY,
                          ) > 2
                        ) {
                          onBeforePlotChange();
                          drag.historyCaptured = true;
                        }
                        if (!drag?.historyCaptured) return;
                        placeFixtureAtClientPosition(fixture.id, event.clientX, event.clientY);
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        fixtureDragRef.current = null;
                      }}
                      onPointerCancel={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        fixtureDragRef.current = null;
                      }}
                      style={{
                        left: `${placed.x * 100}%`,
                        top: `${placed.y * 100}%`,
                      }}
                      title={fixture.name}
                    >
                      {state.intensity > 0.01 ? (
                        <i
                          className={`stageFixtureCone direction-${beamDirection}`}
                          style={
                            {
                              "--beam-color": tint,
                              opacity: Math.min(0.9, state.intensity * 0.88),
                            } as React.CSSProperties
                          }
                        />
                      ) : null}
                      <strong>{fixture.name}</strong>
                      <span>{state.strobe ? `${state.strobe} Hz` : `${Math.round(state.intensity * 100)}%`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="stageMiniTimeline">
        <div className="stageMiniWaveform">
          <strong>SHOW OVERVIEW</strong>
          <div
            className="stageMiniWaveformBars"
            onPointerDown={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setStagePlayheadFromClientX(event.clientX, bounds);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              setStagePlayheadFromClientX(event.clientX, bounds);
            }}
          >
            {waveform.map((sample, index) => (
              <i key={index} style={{ height: `${Math.max(8, sample * 100)}%` }} />
            ))}
          </div>
          <div
            className="stageMiniPlayhead"
            style={{ left: `${(playhead / duration) * 100}%` }}
          />
        </div>
        <div className="stageMiniTracks">
          {fixtures.map((fixture) => {
            const data = timeline?.tracks?.[fixture.id];
            return (
              <div key={fixture.id} className="stageMiniTrackRow">
                <span>{fixture.name}</span>
                <div
                  className="stageMiniTrackLane"
                  onPointerDown={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setStagePlayheadFromClientX(event.clientX, bounds);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setStagePlayheadFromClientX(event.clientX, bounds);
                  }}
                >
                  {data?.points?.length ? (
                    <svg
                      className="miniIntensityGraph"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                    >
                      <path
                        className="miniIntensityBackdrop"
                        d={getMiniIntensityPath(data.points, duration)}
                      />
                      <path d={getMiniIntensityPath(data.points, duration)} />
                    </svg>
                  ) : null}
                  {data?.colors.map((clip) => (
                    <i
                      key={clip.id}
                      className="miniColorClip"
                      style={{
                        left: `${(clip.start / duration) * 100}%`,
                        width: `${(clip.duration / duration) * 100}%`,
                        background: clip.color,
                      }}
                    />
                  ))}
                  {data?.colorTransitions?.map((transition) => (
                    <i
                      key={transition.id}
                      className="miniColorClip miniColorTransition"
                      style={{
                        left: `${(transition.start / duration) * 100}%`,
                        width: `${(transition.duration / duration) * 100}%`,
                        background: `linear-gradient(90deg, ${transition.fromColor}, ${transition.toColor})`,
                      }}
                    />
                  ))}
                  {data?.strobes.map((clip) => (
                    <i
                      key={clip.id}
                      className="miniStrobeClip"
                      style={{
                        left: `${(clip.start / duration) * 100}%`,
                        width: `${(clip.duration / duration) * 100}%`,
                      }}
                    />
                  ))}
                  <div
                    className="stageMiniPlayhead"
                    style={{ left: `${(playhead / duration) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <audio ref={audioRef} preload="auto" />
    </main>
  );
}

type CurvePoint = { x: number; y: number };

export function LegacyTimelineEditor({ fixtures }: { fixtures: PatchedFixture[] }) {
  const [zoom, setZoom] = useState(80);
  const [duration, setDuration] = useState(60);
  const [audioName, setAudioName] = useState("");
  const [waveform, setWaveform] = useState<number[]>(
    createPlaceholderWaveform(160),
  );
  const timelineWidth = Math.max(1200, duration * zoom);

  async function loadAudio(file: File) {
    setAudioName(file.name);
    try {
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      setDuration(Math.max(10, Math.ceil(buffer.duration)));
      setWaveform(extractWaveformSamples(buffer, getWaveformSampleCount(buffer.duration)));
      await context.close();
    } catch {
      setAudioName(`${file.name} (preview unavailable)`);
    }
  }

  return (
    <main className="timelinePage">
      <div className="timelineToolbar">
        <div>
          <p className="eyebrow">SHOW PROGRAMMING</p>
          <h1>Timeline Editor</h1>
        </div>
        <div className="timelineActions">
          <label className="audioPicker">
            <span>{audioName || "Choose audio"}</span>
            <input
              type="file"
              accept="audio/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadAudio(file);
              }}
            />
          </label>
          <label className="zoomControl">
            <span>Horizontal zoom</span>
            <input
              type="range"
              min="25"
              max="240"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
            <strong>{Math.round((zoom / 80) * 100)}%</strong>
          </label>
        </div>
      </div>

      <div className="timelineViewport">
        <div
          className="timelineCanvas"
          style={{ width: timelineWidth, backgroundSize: `${zoom}px 100%` }}
        >
          <TimeRuler duration={duration} zoom={zoom} />
          <div className="playhead" style={{ left: Math.min(12 * zoom, timelineWidth) }}>
            <span>00:12</span>
          </div>
          <div className="fixtureTracks">
            {fixtures.length === 0 ? (
              <div className="emptyTimeline">Add a fixture on the Fixtures page first.</div>
            ) : (
              fixtures.map((fixture) => (
                <FixtureTimelineTrack
                  key={fixture.id}
                  fixture={fixture}
                  width={timelineWidth}
                />
              ))
            )}
          </div>
          <WaveformTrack
            samples={waveform}
            name={audioName || "No audio selected"}
            width={timelineWidth}
          />
        </div>
      </div>
    </main>
  );
}

function TimeRuler({ duration, zoom }: { duration: number; zoom: number }) {
  const marks = Array.from({ length: Math.floor(duration / 5) + 1 }, (_, index) => index * 5);
  return (
    <div className="timeRuler">
      {marks.map((seconds) => (
        <span key={seconds} style={{ left: seconds * zoom }}>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      ))}
    </div>
  );
}

function FixtureTimelineTrack({
  fixture,
  width,
}: {
  fixture: PatchedFixture;
  width: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [curveMode, setCurveMode] = useState<"straight" | "smooth">("smooth");
  const [points, setPoints] = useState<CurvePoint[]>([
    { x: 0, y: 0.82 },
    { x: 0.18, y: 0.82 },
    { x: 0.38, y: 0.25 },
    { x: 0.62, y: 0.7 },
    { x: 0.82, y: 0.4 },
    { x: 1, y: 0.4 },
  ]);

  return (
    <section className={`fixtureTrack ${collapsed ? "trackCollapsed" : ""}`}>
      <button className="trackHeader" onClick={() => setCollapsed(!collapsed)}>
        <span className="collapseIcon">{collapsed ? "›" : "⌄"}</span>
        <span>
          <strong>{fixture.name}</strong>
          <small>DMX {fixture.startAddress} · {getFixtureMode(fixture.modeId).name}</small>
        </span>
        <span className="trackState">ACTIVE</span>
      </button>
      {!collapsed && (
        <div className="trackBody" style={{ width }}>
          <CurveLane
            points={points}
            onChange={setPoints}
            curveMode={curveMode}
            onCurveModeChange={setCurveMode}
          />
          <div className="subLanes">
            <div className="parameterLane colorLane">
              <span>COLOR</span>
              <div className="colorBlock warm">Warm white</div>
              <div className="colorBlock blue">Deep blue</div>
              <div className="colorBlock magenta">Magenta</div>
            </div>
            <div className="parameterLane strobeLane">
              <span>STROBE</span>
              <div className="strobeBlock">8 Hz</div>
              <div className="strobeBlock fast">16 Hz</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CurveLane({
  points,
  onChange,
  curveMode,
  onCurveModeChange,
}: {
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
  curveMode: "straight" | "smooth";
  onCurveModeChange: (mode: "straight" | "smooth") => void;
}) {
  const laneRef = useRef<SVGSVGElement>(null);
  const path =
    curveMode === "straight"
      ? points
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"} ${point.x * 1000} ${point.y * 150}`,
          )
          .join(" ")
      : points.reduce((result, point, index) => {
          const x = point.x * 1000;
          const y = point.y * 150;
          if (index === 0) return `M ${x} ${y}`;
          if (index === points.length - 1) return `${result} T ${x} ${y}`;
          const next = points[index + 1];
          const midpointX = ((point.x + next.x) / 2) * 1000;
          const midpointY = ((point.y + next.y) / 2) * 150;
          return `${result} Q ${x} ${y} ${midpointX} ${midpointY}`;
        }, "");

  function movePoint(index: number, clientX: number, clientY: number) {
    const bounds = laneRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const next = points.map((point, pointIndex) =>
      pointIndex === index
        ? {
            x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
            y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height)),
          }
        : point,
    );
    next.sort((a, b) => a.x - b.x);
    onChange(next);
  }

  return (
    <div className="curveLane">
      <div className="laneLabel">
        <span>INTENSITY</span>
        <div className="curveMode">
          <button
            className={curveMode === "straight" ? "selected" : ""}
            onClick={() => onCurveModeChange("straight")}
          >
            Straight
          </button>
          <button
            className={curveMode === "smooth" ? "selected" : ""}
            onClick={() => onCurveModeChange("smooth")}
          >
            Curve
          </button>
        </div>
      </div>
      <svg ref={laneRef} viewBox="0 0 1000 150" preserveAspectRatio="none">
        <defs>
          <linearGradient id="intensityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#adff2f" stopOpacity=".35" />
            <stop offset="1" stopColor="#adff2f" stopOpacity=".02" />
          </linearGradient>
        </defs>
        <path className="curveArea" d={`${path} L 1000 150 L 0 150 Z`} />
        <path
          className={`intensityPath ${curveMode === "smooth" ? "smoothPath" : ""}`}
          d={path}
        />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={point.x * 1000}
            cy={point.y * 150}
            r="7"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                movePoint(index, event.clientX, event.clientY);
              }
            }}
          />
        ))}
      </svg>
    </div>
  );
}

function WaveformTrack({
  samples,
  name,
  width,
}: {
  samples: number[];
  name: string;
  width: number;
}) {
  return (
    <div className="waveformDock" style={{ width }}>
      <div className="waveformLabel">
        <strong>AUDIO</strong>
        <span>{name}</span>
      </div>
      <div className="waveformBars">
        {samples.map((sample, index) => (
          <i key={index} style={{ height: `${sample * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

function DmxSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="sliderRow">
      <span>{label}</span>

      <input
        type="range"
        min="0"
        max="255"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />

      <strong>{value}</strong>
    </label>
  );
}

export default App;

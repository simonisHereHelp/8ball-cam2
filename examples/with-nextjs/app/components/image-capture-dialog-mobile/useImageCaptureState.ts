// app/components/image-capture-dialog-mobile/useImageCaptureState.ts

import { useRef, useState, useCallback, useEffect } from "react";
import type { WebCameraHandler, FacingMode } from "@shivantra/react-web-camera";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

import { handleSave } from "@/lib/handleSave";
import { handleSummary } from "@/lib/handleSummary";
import { normalizeFilename } from "@/lib/normalizeFilename";
import { findBestSubfolderMatch } from "@/lib/subfolderMatcher";
import {
  CaptureError,
  DEFAULTS,
  normalizeCapture,
} from "../shared/normalizeCapture";
import type { HistoryContextMatch, Image, State, Actions, SubfolderOption } from "./types";
import { playSuccessChime } from "./soundEffects";

interface UseImageCaptureState {
  state: State;
  actions: Actions;
  cameraRef: React.RefObject<WebCameraHandler | null>;
}

interface MatchIssuerResponse {
  matched?: boolean;
  issuerName?: string;
  confidence?: number;
  sourceFile?: string;
}

interface MatchContextResponse {
  matches?: HistoryContextMatch[];
}

const replaceIssuerLine = (summary: string, issuerName: string) => {
  if (!issuerName.trim()) return summary;
  const lines = summary.split(/\r?\n/);
  const nextLine = `單位：${issuerName.trim()}`;
  const issuerIndex = lines.findIndex((line) => /^\s*(?:單位|单位|issuer)\s*[:：]/iu.test(line.trim()));
  if (issuerIndex >= 0) {
    lines[issuerIndex] = nextLine;
    return lines.join("\n");
  }
  return [nextLine, ...lines].join("\n");
};

const fetchIssuerMatch = async (editableSummary: string) => {
  const response = await fetch("/api/match-issuer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editableSummary }),
  });

  if (!response.ok) {
    throw new Error("Unable to match issuer from history.");
  }

  return (await response.json()) as MatchIssuerResponse;
};

const fetchContextMatches = async (editableSummary: string) => {
  const response = await fetch("/api/match-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editableSummary }),
  });

  if (!response.ok) {
    throw new Error("Unable to match related history.");
  }

  const payload = (await response.json()) as MatchContextResponse;
  return payload.matches ?? [];
};

export const useImageCaptureState = (
  onOpenChange?: (open: boolean) => void,
  initialSource: "camera" | "photos" = "camera",
): UseImageCaptureState => {
  const [images, setImages] = useState<Image[]>([]);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [isSaving, setIsSaving] = useState(false);
  const [isProcessingCapture, setIsProcessingCapture] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [captureSource, setCaptureSource] = useState<"camera" | "photos">(initialSource);
  const [draftSummary, setDraftSummary] = useState("");
  const [editableSummary, setEditableSummary] = useState("");
  const [trainingSummary, setTrainingSummary] = useState("");
  const [summaryImageUrl, setSummaryImageUrl] = useState<string | null>(null);
  const [showSummaryOverlay, setShowSummaryOverlay] = useState(false);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [availableSubfolders, setAvailableSubfolders] = useState<SubfolderOption[]>([]);
  const [selectedSubfolder, setSelectedSubfolder] = useState<SubfolderOption | null>(null);
  const [subfolderLoading, setSubfolderLoading] = useState(false);
  const [subfolderError, setSubfolderError] = useState("");
  const [matchedIssuerName, setMatchedIssuerName] = useState("");
  const [matchedIssuerSource, setMatchedIssuerSource] = useState("");
  const [historyContextMatches, setHistoryContextMatches] = useState<HistoryContextMatch[]>([]);
  const [historyMatchLoading, setHistoryMatchLoading] = useState(false);
  const [isSubfolderAutoSelected, setIsSubfolderAutoSelected] = useState(true);

  const cameraRef = useRef<WebCameraHandler | null>(null);
  const { data: session } = useSession();
  const router = useRouter();

  useEffect(() => {
    setCaptureSource(initialSource);
  }, [initialSource]);

  const deleteImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleClose = useCallback(() => {
    if (images.length > 0 && !isSaving) {
      if (!window.confirm("You have unsaved images. Are you sure you want to close?")) {
        return;
      }
    }

    setImages([]);
    setDraftSummary("");
    setEditableSummary("");
    setTrainingSummary("");
    setSummaryImageUrl(null);
    setError("");
    setSaveMessage("");
    setShowSummaryOverlay(false);
    setShowGallery(false);
    setAvailableSubfolders([]);
    setSelectedSubfolder(null);
    setSubfolderError("");
    setMatchedIssuerName("");
    setMatchedIssuerSource("");
    setHistoryContextMatches([]);
    setCaptureSource(initialSource);
    setIsProcessingCapture(false);
    onOpenChange?.(false);
  }, [images.length, initialSource, isSaving, onOpenChange]);

  const ingestFile = useCallback(
    async (file: File, source: "camera" | "photos", preferredName?: string) => {
      setIsProcessingCapture(true);
      setError("");
      try {
        const { file: normalizedFile, previewUrl } = await normalizeCapture(file, source, {
          maxFileSize: DEFAULTS.MAX_FILE_SIZE,
          preferredName,
        });

        setSummaryImageUrl(null);
        setDraftSummary("");
        setEditableSummary("");
        setTrainingSummary("");
        setSaveMessage("");
        setShowGallery(false);
        setSelectedSubfolder(null);
        setIsSubfolderAutoSelected(true);
        setMatchedIssuerName("");
        setMatchedIssuerSource("");
        setHistoryContextMatches([]);
        setImages((prev) => [...prev, { url: previewUrl, file: normalizedFile }]);
      } catch (err) {
        setError(err instanceof CaptureError ? err.message : "Unable to process the image.");
      } finally {
        setIsProcessingCapture(false);
      }
    },
    [],
  );

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const file = await cameraRef.current.capture();
      if (file) await ingestFile(file, "camera", `capture-${Date.now()}.jpeg`);
    } catch {
      setError("Unable to access camera capture.");
    }
  }, [ingestFile]);

  const handleAlbumSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await ingestFile(files[0], "photos");
  }, [ingestFile]);

  const handleCameraSwitch = useCallback(async () => {
    if (!cameraRef.current) return;
    const newMode = facingMode === "user" ? "environment" : "user";
    await cameraRef.current.switch(newMode);
    setFacingMode(newMode);
  }, [facingMode]);

  const refreshSubfolders = useCallback(async () => {
    if (subfolderLoading) return;
    setSubfolderLoading(true);
    setSubfolderError("");
    try {
      const response = await fetch("/api/active-subfolders");
      if (!response.ok) {
        throw new Error("Unable to load subfolder options.");
      }
      const json = (await response.json().catch(() => null)) as { subfolders?: SubfolderOption[] } | null;
      setAvailableSubfolders(json?.subfolders ?? []);
    } catch (err) {
      setSubfolderError(err instanceof Error ? err.message : "Unable to load subfolder options.");
    } finally {
      setSubfolderLoading(false);
    }
  }, [subfolderLoading]);

  const selectSubfolder = useCallback((subfolder: SubfolderOption) => {
    setSelectedSubfolder(subfolder);
    setIsSubfolderAutoSelected(false);
  }, []);

  const handleSummarize = useCallback(async () => {
    setSaveMessage("");
    setError("");
    setHistoryContextMatches([]);
    setMatchedIssuerName("");
    setMatchedIssuerSource("");

    const resolvedSummary = await handleSummary({
      images,
      setIsSaving,
      setSummaryImageUrl,
      setShowSummaryOverlay,
      setError,
    });

    if (!resolvedSummary) return;

    setDraftSummary(resolvedSummary);
    setTrainingSummary("");

    let nextSummary = resolvedSummary;
    setHistoryMatchLoading(true);

    try {
      const issuerMatch = await fetchIssuerMatch(nextSummary);
      if (issuerMatch.matched && issuerMatch.issuerName) {
        nextSummary = replaceIssuerLine(nextSummary, issuerMatch.issuerName);
        setMatchedIssuerName(issuerMatch.issuerName);
        setMatchedIssuerSource(issuerMatch.sourceFile?.trim() || "");
      }

      const contextMatches = await fetchContextMatches(nextSummary);
      setHistoryContextMatches(contextMatches);
    } catch (matchError) {
      console.warn("History matching failed:", matchError);
    } finally {
      setHistoryMatchLoading(false);
    }

    setEditableSummary(nextSummary);

    if (images.length > 0) {
      setShowGallery(true);
    }
  }, [images]);

  useEffect(() => {
    if (!editableSummary.trim() || !availableSubfolders.length) {
      if (isSubfolderAutoSelected) {
        setSelectedSubfolder(null);
      }
      return;
    }

    const inferredSubfolder = findBestSubfolderMatch(editableSummary, availableSubfolders);
    if (!selectedSubfolder || isSubfolderAutoSelected) {
      setSelectedSubfolder((current) => {
        if (!inferredSubfolder) return null;
        return current?.topic === inferredSubfolder.topic ? current : inferredSubfolder;
      });
      setIsSubfolderAutoSelected(true);
    }
  }, [editableSummary, availableSubfolders, selectedSubfolder, isSubfolderAutoSelected]);

  useEffect(() => {
    if (showGallery && !availableSubfolders.length && !subfolderLoading) {
      refreshSubfolders();
    }
  }, [showGallery, availableSubfolders.length, subfolderLoading, refreshSubfolders]);

  const handleSaveImages = useCallback(async () => {
    if (!session || isSaving) return;

    const finalSummary = editableSummary.trim();
    if (!finalSummary) {
      setError("Please ensure the summary is not empty before saving.");
      return;
    }

    setSaveMessage("");
    setError("");

    await handleSave({
      images,
      draftSummary,
      finalSummary,
      trainingSummary,
      selectedSubfolder,
      setIsSaving,
      onError: setError,
      onSuccess: ({ setName, targetFolderId, topic }) => {
        setShowGallery(false);
        const folderPath = topic || targetFolderId?.split("/").pop() || "Drive";
        const displayPath = folderPath.replace(/^Drive_/, "");
        const resolvedName = normalizeFilename(setName || "(untitled)");

        sessionStorage.setItem(
          "uploadConfirmation",
          JSON.stringify({ folder: displayPath, filename: resolvedName }),
        );
        window.dispatchEvent(new Event("upload-confirmation"));
        setSaveMessage(`uploaded to: ${displayPath} ✅\nname: ${resolvedName} ✅`);
        setImages([]);
        setDraftSummary("");
        setEditableSummary("");
        setTrainingSummary("");
        setSelectedSubfolder(null);
        setMatchedIssuerName("");
        setMatchedIssuerSource("");
        setHistoryContextMatches([]);
        playSuccessChime();
        onOpenChange?.(false);
        router.push("/");
      },
    });
  }, [
    session,
    isSaving,
    images,
    draftSummary,
    editableSummary,
    trainingSummary,
    selectedSubfolder,
    onOpenChange,
    router,
  ]);

  const state: State = {
    images,
    facingMode,
    isSaving,
    isProcessingCapture,
    showGallery,
    cameraError,
    captureSource,
    draftSummary,
    editableSummary,
    trainingSummary,
    summaryImageUrl,
    error,
    saveMessage,
    availableSubfolders,
    selectedSubfolder,
    subfolderLoading,
    subfolderError,
    showSummaryOverlay,
    matchedIssuerName,
    matchedIssuerSource,
    historyContextMatches,
    historyMatchLoading,
  };

  const actions: Actions = {
    deleteImage,
    handleCapture,
    handleAlbumSelect,
    handleCameraSwitch,
    handleSummarize,
    handleSaveImages,
    handleClose,
    setCaptureSource,
    setEditableSummary,
    setTrainingSummary,
    setDraftSummary,
    setShowGallery,
    setCameraError,
    setError,
    refreshSubfolders,
    selectSubfolder,
  };

  return { state, actions, cameraRef };
};

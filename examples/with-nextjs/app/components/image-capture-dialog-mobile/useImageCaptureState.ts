// app/components/image-capture-dialog-mobile/useImageCaptureState.ts

import { useRef, useState, useCallback, useEffect } from "react";
import type { WebCameraHandler, FacingMode } from "@shivantra/react-web-camera";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { handleSave } from "@/lib/handleSave";
import { handleSummary } from "@/lib/handleSummary";
import { normalizeFilename } from "@/lib/normalizeFilename";
import { findBestIssuerCanon } from "@/lib/issuerCanonMatcher";
import { findBestSubfolderMatch } from "@/lib/subfolderMatcher";
import {
  CaptureError,
  DEFAULTS,
  normalizeCapture,
} from "../shared/normalizeCapture";
import type { Image, State, Actions, SubfolderOption } from "./types";
import {
  applyCanonToSummary,
  fetchIssuerCanonList,
  type IssuerCanonEntry,
} from "./issuerCanonUtils";
import { playSuccessChime } from "./soundEffects";

interface UseImageCaptureState {
  state: State;
  actions: Actions;
  cameraRef: React.RefObject<WebCameraHandler | null>;
}

export const useImageCaptureState = (
  onOpenChange?: (open: boolean) => void,
  initialSource: "camera" | "photos" = "camera",
): UseImageCaptureState => {
  // --- Core State ---
  const [images, setImages] = useState<Image[]>([]);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [isSaving, setIsSaving] = useState(false);
  const [isProcessingCapture, setIsProcessingCapture] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [captureSource, setCaptureSource] = useState<"camera" | "photos">(initialSource);

  // --- Summary & AI State ---
  const [draftSummary, setDraftSummary] = useState(""); // Original AI output
  const [editableSummary, setEditableSummary] = useState(""); // User's working text
  const [trainingSummary, setTrainingSummary] = useState("");
  const [summaryImageUrl, setSummaryImageUrl] = useState<string | null>(null);
  const [showSummaryOverlay, setShowSummaryOverlay] = useState(false);

  // --- UI Feedback State ---
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [availableSubfolders, setAvailableSubfolders] = useState<SubfolderOption[]>([]);
  const [selectedSubfolder, setSelectedSubfolder] = useState<SubfolderOption | null>(null);
  const [subfolderLoading, setSubfolderLoading] = useState(false);
  const [subfolderError, setSubfolderError] = useState("");

  // --- Canon / Metadata State ---
  const [issuerCanons, setIssuerCanons] = useState<IssuerCanonEntry[]>([]);
  const [issuerCanonsLoading, setIssuerCanonsLoading] = useState(false);
  const [canonError, setCanonError] = useState("");
  const [selectedCanon, setSelectedCanon] = useState<IssuerCanonEntry | null>(null);
  const [isCanonAutoSelected, setIsCanonAutoSelected] = useState(true);
  const [isSubfolderAutoSelected, setIsSubfolderAutoSelected] = useState(true);

  const cameraRef = useRef<WebCameraHandler | null>(null);
  const { data: session } = useSession();
  const router = useRouter();

  // Keep capture source in sync with props
  useEffect(() => {
    setCaptureSource(initialSource);
  }, [initialSource]);

  // --- Handlers ---

  const deleteImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleClose = useCallback(() => {
    if (images.length > 0 && !isSaving) {
      if (!window.confirm("You have unsaved images. Are you sure you want to close?")) {
        return;
      }
    }
    // Reset all state
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
    setIssuerCanons([]);
    setCanonError("");
    setSelectedCanon(null);
    setIsCanonAutoSelected(true);
    setIsSubfolderAutoSelected(true);
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

        // Reset summary context for the new set of images
        setSummaryImageUrl(null);
        setDraftSummary("");
        setEditableSummary("");
        setTrainingSummary("");
        setSaveMessage("");
        setShowGallery(false);
        setSelectedCanon(null);
        setSelectedSubfolder(null);
        setIsCanonAutoSelected(true);
        setIsSubfolderAutoSelected(true);
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
    } catch (err) {
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

  const handleSummarize = useCallback(async () => {
    setSaveMessage("");
    setError("");
    
    const setSummaries = (newSummary: string) => {
      setDraftSummary(newSummary);
      setEditableSummary(newSummary); 
      setTrainingSummary("");
    };
    
    const didSummarize = await handleSummary({
      images,
      setIsSaving,
      setSummary: setSummaries,
      setSummaryImageUrl,
      setShowSummaryOverlay,
      setError,
    });

    if (didSummarize && images.length > 0) {
      setShowGallery(true);
      playSuccessChime();
    }
  }, [images]);

  const refreshCanons = useCallback(async () => {
    if (issuerCanonsLoading) return;
    setIssuerCanonsLoading(true);
    setCanonError("");
    try {
      const entries = await fetchIssuerCanonList();
      setIssuerCanons(entries);
    } catch (err) {
      setCanonError(err instanceof Error ? err.message : "Unable to load canon list.");
    } finally {
      setIssuerCanonsLoading(false);
    }
  }, [issuerCanonsLoading]);

  const refreshSubfolders = useCallback(async () => {
    if (subfolderLoading) return;
    setSubfolderLoading(true);
    setSubfolderError("");
    try {
      const response = await fetch("/api/active-subfolders");
      if (!response.ok) {
        throw new Error("Unable to load subfolder options.");
      }
      const json = (await response.json().catch(() => null)) as
        | { subfolders?: SubfolderOption[] }
        | null;
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

  const selectCanon = useCallback((canon: IssuerCanonEntry) => {
    const nextSummary = applyCanonToSummary({
      canon,
      currentSummary: editableSummary,
      draftSummary,
    });

    setSelectedCanon(canon);
    setIsCanonAutoSelected(false);
    setEditableSummary(nextSummary);

    const inferredSubfolder = findBestSubfolderMatch(nextSummary, availableSubfolders);
    setSelectedSubfolder(inferredSubfolder);
    setIsSubfolderAutoSelected(true);
  }, [availableSubfolders, draftSummary, editableSummary]);

  useEffect(() => {
    if (!editableSummary.trim() || !issuerCanons.length) {
      if (isCanonAutoSelected) {
        setSelectedCanon(null);
      }
      return;
    }

    const inferredCanon = findBestIssuerCanon(editableSummary, issuerCanons);
    if (!selectedCanon || isCanonAutoSelected) {
      setSelectedCanon((current) => {
        if (!inferredCanon) return null;
        return current?.master === inferredCanon.master ? current : inferredCanon;
      });
      setIsCanonAutoSelected(true);
    }
  }, [editableSummary, issuerCanons, selectedCanon, isCanonAutoSelected]);

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
  }, [
    editableSummary,
    availableSubfolders,
    selectedSubfolder,
    isSubfolderAutoSelected,
  ]);

  // Auto-refresh canons when gallery opens
  useEffect(() => {
    if (showGallery && !issuerCanons.length && !issuerCanonsLoading) {
      refreshCanons();
    }
  }, [showGallery, issuerCanons.length, issuerCanonsLoading, refreshCanons]);

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
      selectedCanon,
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
        setSelectedCanon(null);
        setSelectedSubfolder(null);
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
    selectedCanon,
    selectedSubfolder,
    onOpenChange,
    router,
  ]);

  // --- Aggregate State & Actions ---

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
    issuerCanons,
    issuerCanonsLoading,
    canonError,
    selectedCanon,
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
    setCanonError,
    refreshSubfolders,
    selectSubfolder,
    refreshCanons,
    selectCanon,
  };

  return { state, actions, cameraRef };
};

import type React from "react"; // Required for React.RefObject
import type { FacingMode, WebCameraHandler } from "@shivantra/react-web-camera";
import type { IssuerCanonEntry } from "./issuerCanonUtils";

export interface Image {
  url: string;
  file: File;
}

export interface SubfolderOption {
  topic: string;
  folderId?: string;
  keywords?: string[];
  excluded_keywords?: string[];
  description?: string;
}

export interface State {
  images: Image[];
  facingMode: FacingMode;
  isSaving: boolean;
  isProcessingCapture: boolean;
  showGallery: boolean;
  cameraError: boolean;
  captureSource: "camera" | "photos";
  draftSummary: string;     // The original AI output
  editableSummary: string;  // What the user sees and edits
  summaryImageUrl: string | null;
  showSummaryOverlay: boolean;
  error: string;
  saveMessage: string;
  availableSubfolders: SubfolderOption[];
  selectedSubfolder: SubfolderOption | null;
  subfolderLoading: boolean;
  subfolderError: string;
  issuerCanons: IssuerCanonEntry[];
  issuerCanonsLoading: boolean;
  canonError: string;
  selectedCanon: IssuerCanonEntry | null;
}

export interface Actions {
  deleteImage: (index: number) => void;
  handleCapture: () => Promise<void>;
  handleCameraSwitch: () => Promise<void>;
  handleAlbumSelect: (files: FileList | null) => Promise<void>;
  handleSummarize: () => Promise<void>;
  handleSaveImages: () => Promise<void>;
  handleClose: () => void;
  setCaptureSource: (source: "camera" | "photos") => void;
  setEditableSummary: (summary: string) => void;
  setDraftSummary: (summary: string) => void;
  setShowGallery: (show: boolean) => void;
  setCameraError: (error: boolean) => void;
  setError: (message: string) => void;
  setCanonError: (message: string) => void;
  refreshSubfolders: () => Promise<void>;
  selectSubfolder: (subfolder: SubfolderOption) => void;
  refreshCanons: () => Promise<void>;
  selectCanon: (canon: IssuerCanonEntry) => void;
}

export interface CameraViewProps {
  state: State;
  actions: Actions;
  cameraRef: React.RefObject<WebCameraHandler | null>;
}

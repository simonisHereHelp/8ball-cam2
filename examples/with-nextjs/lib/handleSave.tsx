// app/lib/handleSave.ts

import { playSuccessChime } from "../app/components/image-capture-dialog-mobile/soundEffects";

export interface Image {
  url: string;
  file: File;
}

export interface SelectedSubfolderMeta {
  topic: string;
  folderId?: string;
}

export const handleSave = async ({
  images,
  draftSummary,
  finalSummary,
  trainingSummary,
  selectedSubfolder,
  setIsSaving,
  onError,
  onSuccess,
}: {
  images: Image[];
  draftSummary: string;
  finalSummary: string;
  trainingSummary?: string;
  selectedSubfolder?: SelectedSubfolderMeta | null;
  setIsSaving: (isSaving: boolean) => void;
  onError?: (message: string) => void;
  onSuccess?: (meta: {
    setName: string;
    targetFolderId?: string | null;
    topic?: string | null;
  }) => void;
}): Promise<boolean> => {
  if (!images.length) return false;

  const trimmedFinalSummary = finalSummary.trim();
  if (!trimmedFinalSummary) return false;

  setIsSaving(true);

  try {
    const formData = new FormData();
    formData.append("summary", trimmedFinalSummary);
    formData.append("draftSummary", draftSummary.trim());
    formData.append("trainingSummary", trainingSummary?.trim() ?? "");

    if (selectedSubfolder) {
      formData.append("selectedSubfolder", JSON.stringify(selectedSubfolder));
    }

    images.forEach((image) => {
      formData.append("files", image.file);
    });

    const response = await fetch("/api/save-set", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Failed to save files to Google Drive.");
    }

    const json = (await response.json().catch(() => null)) as
      | { setName?: string; targetFolderId?: string | null; topic?: string | null }
      | null;

    onSuccess?.({
      setName: json?.setName ?? "",
      targetFolderId: json?.targetFolderId ?? null,
      topic: json?.topic ?? null,
    });

    playSuccessChime();
    return true;
  } catch (error) {
    console.error("Failed to save images:", error);
    onError?.("Unable to save captured images. Please try again.");
    return false;
  } finally {
    setIsSaving(false);
  }
};

// app/lib/handleSave.ts

import { playSuccessChime } from "../app/components/image-capture-dialog-mobile/soundEffects";

export interface Image {
  url: string;
  file: File;
}

export interface SelectedCanonMeta {
  master: string;
  aliases?: string[];
}

export interface SelectedSubfolderMeta {
  topic: string;
  folderId?: string;
}

/**
 * Saves the current images + summary via /api/save-set.
 * The server-side LLM router is responsible for deriving setName.
 */
export const handleSave = async ({
  images,
  draftSummary,
  finalSummary,
  trainingSummary,
  selectedCanon,
  selectedSubfolder,
  setIsSaving,
  onError,
  onSuccess,
}: {
  images: Image[];
  draftSummary: string;
  finalSummary: string;
  trainingSummary?: string;
  selectedCanon?: SelectedCanonMeta | null;
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

    if (selectedCanon) {
      formData.append("selectedCanon", JSON.stringify(selectedCanon));
    }
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

    try {
      const updateResponse = await fetch("/api/update-issuerCanon", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          draftSummary: draftSummary.trim(),
          finalSummary: trimmedFinalSummary,
        }),
        credentials: "include",
      });

      if (!updateResponse.ok) {
        console.warn(`[update-issuerCanon] Server warning/error: ${updateResponse.status}`);
      }

      console.log("[update-issuerCanon] Finished attempt.");
    } catch (e) {
      console.error("Error calling /api/update-issuerCanon:", e);
    }

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

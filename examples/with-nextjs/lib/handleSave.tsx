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
  draftSummary, // ✅ 原始 LLM 輸出
  finalSummary, // ✅ 用戶編輯後的最終摘要
  selectedCanon,
  selectedSubfolder,
  setIsSaving,
  onError,
  onSuccess,
}: {
  images: Image[];
  draftSummary: string;
  finalSummary: string;
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
  // nothing to save
  if (!images.length) return false;

  const trimmedFinalSummary = finalSummary.trim();
  // Check against the final edited summary
  if (!trimmedFinalSummary) return false;

  setIsSaving(true);

  try {
    const formData = new FormData();

    // 1. Send the edited summary as the 'summary' form field (used for setName derivation)
    formData.append("summary", trimmedFinalSummary);

    // Include issuer canon metadata for markdown generation on the server
    if (selectedCanon) {
      formData.append("selectedCanon", JSON.stringify(selectedCanon));
    }
    if (selectedSubfolder) {
      formData.append("selectedSubfolder", JSON.stringify(selectedSubfolder));
    }

    // 3. all captured images — server will rename to {setName}-pX.ext or similar
    images.forEach((image) => {
      formData.append("files", image.file);
    });

    // API call to the correct endpoint /api/save-set
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

    // 2️⃣ Canonical Update: ping /api/update-issuerCanon with summaries
    try {
        // ✅ 修正了 API 端點名稱與參數
        const updateResponse = await fetch("/api/update-issuerCanon", {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                draftSummary: draftSummary.trim(),
                finalSummary: trimmedFinalSummary,
            }),
            credentials: "include"
        });

        if (!updateResponse.ok) {
            console.warn(`[update-issuerCanon] Server warning/error: ${updateResponse.status}`);
        }

        console.log("[update-issuerCanon] Finished attempt.");
    } catch (e) {
      // canonicals update should not block main save flow
      console.error("Error calling /api/update-issuerCanon:", e);
    }


    // 🔔 let the UI know the final server-side setName (if provided)
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

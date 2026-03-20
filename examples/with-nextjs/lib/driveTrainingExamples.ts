import { Buffer } from "buffer";

import { auth } from "@/auth";
import { driveSaveFiles } from "@/lib/driveSaveFiles";
import { normalizeFilename } from "@/lib/normalizeFilename";

const TRAINING_FOLDER_ID = process.env.DRIVE_FOLDER_ID_DOCS_TRAINING;

export interface TrainingLogRecord {
  originalSummary: string;
  finalSummary: string;
  correctionNote: string;
  tags: string[];
  images: string[];
  issuer?: string;
  docType?: string;
  action?: string;
  createdAt: string;
}

export interface TrainingExample extends TrainingLogRecord {
  fileName: string;
  imageDataUrls: string[];
}

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const resolveMimeType = (fileName: string) => {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  return MIME_TYPE_BY_EXTENSION[extension] || "application/octet-stream";
};

const getAccessToken = async () => {
  const session = await auth();
  const accessToken = (session as any)?.accessToken as string | undefined;
  if (!accessToken) {
    throw new Error("Missing Google Drive access token on session.");
  }
  return accessToken;
};

const listFolderFiles = async (folderId: string, accessToken: string) => {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime,modifiedTime)&orderBy=modifiedTime desc&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to list training files: ${response.status} ${text}`);
  }

  const json = (await response.json().catch(() => null)) as
    | {
        files?: Array<{
          id: string;
          name: string;
          createdTime?: string;
          modifiedTime?: string;
        }>;
      }
    | null;

  return json?.files ?? [];
};

const downloadTextFile = async (fileId: string, accessToken: string) => {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to download training log: ${response.status} ${text}`);
  }

  return response.text();
};

const downloadImageAsDataUrl = async (
  fileId: string,
  fileName: string,
  accessToken: string,
) => {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to download training image '${fileName}': ${response.status} ${text}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${resolveMimeType(fileName)};base64,${buffer.toString("base64")}`;
};

const sanitizeTag = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

export const buildTrainingTags = (...values: Array<string | null | undefined>) =>
  Array.from(
    new Set(
      values
        .map((value) => (value ? sanitizeTag(value) : ""))
        .filter((value) => value.length > 0),
    ),
  );

export const getLatestTrainingExamples = async (limit = 2): Promise<TrainingExample[]> => {
  if (!TRAINING_FOLDER_ID) return [];

  const accessToken = await getAccessToken();
  const folderFiles = await listFolderFiles(TRAINING_FOLDER_ID, accessToken);
  const logFiles = folderFiles.filter((file) => /-cLog\.json$/i.test(file.name)).slice(0, limit);
  const fileByName = new Map(folderFiles.map((file) => [file.name, file]));

  const examples = await Promise.all(
    logFiles.map(async (file) => {
      const raw = await downloadTextFile(file.id, accessToken);
      const parsed = JSON.parse(raw) as Partial<TrainingLogRecord>;
      const images = Array.isArray(parsed.images) ? parsed.images : [];
      const imageDataUrls = await Promise.all(
        images.map(async (imageRef) => {
          const imageName = imageRef.replace(/^\.\/+/, "");
          const imageFile = fileByName.get(imageName);
          if (!imageFile) return null;
          return downloadImageAsDataUrl(imageFile.id, imageFile.name, accessToken);
        }),
      );

      return {
        fileName: file.name,
        originalSummary: parsed.originalSummary?.trim() || "",
        finalSummary: parsed.finalSummary?.trim() || "",
        correctionNote: parsed.correctionNote?.trim() || "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [],
        images,
        issuer: parsed.issuer?.trim(),
        docType: parsed.docType?.trim(),
        action: parsed.action?.trim(),
        createdAt: parsed.createdAt?.trim() || file.modifiedTime || file.createdTime || "",
        imageDataUrls: imageDataUrls.filter((value): value is string => Boolean(value)),
      } satisfies TrainingExample;
    }),
  );

  return examples.filter(
    (example) => example.finalSummary.length > 0 && example.imageDataUrls.length > 0,
  );
};

export const saveTrainingExample = async (params: {
  setName: string;
  log: TrainingLogRecord;
  imageFiles: File[];
}) => {
  if (!TRAINING_FOLDER_ID) return;

  const { setName, log, imageFiles } = params;
  const baseName = normalizeFilename(setName.replace(/[\\/:*?"<>|]/g, "_"));
  const trainingLogFile = new File(
    [JSON.stringify(log, null, 2)],
    `${baseName}-cLog.json`,
    { type: "application/json" },
  );

  await driveSaveFiles({
    folderId: TRAINING_FOLDER_ID,
    files: [...imageFiles, trainingLogFile],
    fileToUpload: async (file) => {
      if (file === trainingLogFile) {
        return {
          name: trainingLogFile.name,
          buffer: Buffer.from(await file.arrayBuffer()),
          mimeType: "application/json",
        };
      }

      return {
        name: file.name,
        buffer: Buffer.from(await file.arrayBuffer()),
        mimeType: file.type || resolveMimeType(file.name),
      };
    },
  });
};

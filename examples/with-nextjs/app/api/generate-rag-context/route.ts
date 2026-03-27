import { auth } from "@/auth";
import { GPT_Router } from "@/lib/gptRouter";
import { DRIVE_ACTIVE_SUBFOLDER_SOURCE } from "@/lib/jsonCanonSources";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const QDRANT_URL =
  process.env.QDRANT_URL ||
  "https://09d1087a-9021-40cf-a060-5c3d33f14a8c.us-west-1-0.aws.cloud.qdrant.io:6333";
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION_NAME || "documents";
const QDRANT_VECTOR_SIZE = Number(process.env.QDRANT_VECTOR_SIZE || 384);
const BASE_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

interface ActiveSubfolder {
  topic: string;
  folderId?: string;
}

interface DriveFileRow {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
}

const buildFolderPath = (slugOrPath: string, base: string) => {
  if (!slugOrPath) return base;
  if (slugOrPath.startsWith(`${base}/`) || slugOrPath === base) return slugOrPath;
  if (slugOrPath.includes("/")) return slugOrPath;
  return `${base}/${slugOrPath}`;
};

const normalizeSubfolderConfig = (config: unknown): ActiveSubfolder[] => {
  if (!config) return [];
  if (Array.isArray(config)) return config as ActiveSubfolder[];
  const typed = config as { subfolders?: ActiveSubfolder[] };
  return Array.isArray(typed?.subfolders) ? typed.subfolders : [];
};

const getAccessToken = async () => {
  const session = await auth();
  if (!session) throw new Error("Not authenticated.");
  const accessToken = (session as any)?.accessToken as string | undefined;
  if (!accessToken) throw new Error("Missing Google Drive access token on session.");
  return accessToken;
};

const embedText = async (text: string) => {
  const vector = new Array(QDRANT_VECTOR_SIZE).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % QDRANT_VECTOR_SIZE] += text.charCodeAt(index) % 97;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
};

const listFolderEntries = async (folderId: string, accessToken: string) => {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,parents)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to list Drive folder '${folderId}': ${response.status} ${text}`);
  }

  const json = (await response.json().catch(() => null)) as { files?: DriveFileRow[] } | null;
  return json?.files ?? [];
};

const downloadDriveTextFile = async (fileId: string, accessToken: string) => {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to download Drive file '${fileId}': ${response.status} ${text}`);
  }

  return response.text();
};

const resolveFolderIdFromPath = async (folderPath: string, accessToken: string) => {
  const parts = folderPath.split("/").filter(Boolean);
  if (!parts.length) throw new Error("Malformed Drive folder path");

  let currentId = parts.shift()!;
  for (const segment of parts) {
    const query = encodeURIComponent(
      `name = '${segment.replace(/'/g, "\\'")}' and '${currentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    );
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Failed to resolve Drive folder '${segment}': ${response.status} ${text}`);
    }

    const json = (await response.json().catch(() => null)) as
      | { files?: Array<{ id: string; name: string }> }
      | null;
    const nextId = json?.files?.[0]?.id;
    if (!nextId) {
      throw new Error(`Drive subfolder '${segment}' not found under '${currentId}'`);
    }
    currentId = nextId;
  }

  return currentId;
};

const collectJsonFilesRecursively = async (
  rootFolderId: string,
  accessToken: string,
  pathLabel: string,
): Promise<Array<DriveFileRow & { drivePath: string }>> => {
  const queue: Array<{ id: string; pathLabel: string }> = [{ id: rootFolderId, pathLabel }];
  const results: Array<DriveFileRow & { drivePath: string }> = [];

  while (queue.length) {
    const current = queue.shift()!;
    const entries = await listFolderEntries(current.id, accessToken);

    for (const entry of entries) {
      if (entry.mimeType === "application/vnd.google-apps.folder") {
        queue.push({
          id: entry.id,
          pathLabel: `${current.pathLabel}/${entry.name}`,
        });
        continue;
      }

      if (/\.json$/i.test(entry.name)) {
        results.push({
          ...entry,
          drivePath: `${current.pathLabel}/${entry.name}`,
        });
      }
    }
  }

  return results;
};

const ensureQdrantCollection = async () => {
  const response = await fetch(
    `${QDRANT_URL.replace(/\/+$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({
        vectors: {
          size: QDRANT_VECTOR_SIZE,
          distance: "Cosine",
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to ensure Qdrant collection: ${response.status} ${text}`);
  }
};

const buildIndexText = (doc: Record<string, any>, fileName: string, drivePath: string, topic: string) =>
  [
    topic,
    drivePath,
    fileName,
    doc.issuer_name || "",
    doc.issuer_alias || "",
    doc.subject_category || "",
    doc.doc_class || "",
    doc.actionable_in_verb || "",
    doc.doc_date || "",
    doc.title || "",
    doc.summary || "",
    Array.isArray(doc.incident_keys) ? doc.incident_keys.join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n");

const approximateTokenCount = (text: string) => Math.max(1, Math.round(text.length / 4));

const upsertQdrantPoints = async (points: Array<Record<string, any>>) => {
  const response = await fetch(
    `${QDRANT_URL.replace(/\/+$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points?wait=true`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({ points }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to upsert Qdrant points: ${response.status} ${text}`);
  }
};

export async function POST() {
  try {
    if (!BASE_DRIVE_FOLDER_ID) {
      return NextResponse.json({ ok: false, error: "Missing DRIVE_FOLDER_ID" }, { status: 500 });
    }

    const accessToken = await getAccessToken();
    const config = await GPT_Router.fetchJsonSource(DRIVE_ACTIVE_SUBFOLDER_SOURCE);
    const subfolders = normalizeSubfolderConfig(config);

    if (!subfolders.length) {
      return NextResponse.json(
        { ok: false, error: "No active Drive subfolders configured." },
        { status: 400 },
      );
    }

    await ensureQdrantCollection();

    const indexedFolders: Array<{ topic: string; fileCount: number }> = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    let indexedCount = 0;
    let totalIndexedChars = 0;
    let totalIndexedTokens = 0;

    for (const subfolder of subfolders) {
      const folderPath = buildFolderPath(subfolder.folderId || subfolder.topic, BASE_DRIVE_FOLDER_ID);
      const resolvedFolderId = await resolveFolderIdFromPath(folderPath, accessToken);
      const jsonFiles = await collectJsonFilesRecursively(
        resolvedFolderId,
        accessToken,
        subfolder.topic,
      );

      indexedFolders.push({ topic: subfolder.topic, fileCount: jsonFiles.length });

      for (const file of jsonFiles) {
        try {
          const raw = await downloadDriveTextFile(file.id, accessToken);
          const doc = JSON.parse(raw) as Record<string, any>;
          const indexText = buildIndexText(doc, file.name, file.drivePath, subfolder.topic);
          const approxTokens = approximateTokenCount(indexText);
          const vector = await embedText(indexText);

          await upsertQdrantPoints([
            {
              id: file.id,
              vector,
              payload: {
                drive_file_id: file.id,
                drive_path: file.drivePath,
                topic: subfolder.topic,
                file_name: file.name,
                issuer_name: doc.issuer_name || "",
                issuer_alias: doc.issuer_alias || "",
                subject_category: doc.subject_category || "",
                doc_class: doc.doc_class || "",
                actionable_in_verb: doc.actionable_in_verb || "",
                doc_date: doc.doc_date || "",
                title: doc.title || "",
                summary: doc.summary || "",
                incident_keys: Array.isArray(doc.incident_keys) ? doc.incident_keys : [],
                file_group_id: doc.file_group_id || "",
              },
            },
          ]);

          indexedCount += 1;
          totalIndexedChars += indexText.length;
          totalIndexedTokens += approxTokens;
          console.log("/api/generate-rag-context Qdrant upsert:", {
            topic: subfolder.topic,
            drivePath: file.drivePath,
            fileId: file.id,
            vectorSize: vector.length,
            indexedChars: indexText.length,
            approxIndexedTokens: approxTokens,
            payloadKeys: [
              "drive_file_id",
              "drive_path",
              "topic",
              "file_name",
              "issuer_name",
              "issuer_alias",
              "subject_category",
              "doc_class",
              "actionable_in_verb",
              "doc_date",
              "title",
              "summary",
              "incident_keys",
              "file_group_id",
            ],
          });
        } catch (error: any) {
          skippedFiles.push({
            path: file.drivePath,
            reason: error?.message || "Unknown indexing error",
          });
        }
      }
    }

    console.log("/api/generate-rag-context indexing summary:", {
      indexedCount,
      skippedCount: skippedFiles.length,
      totalIndexedChars,
      totalIndexedTokens,
      averageIndexedTokensPerFile: indexedCount ? Math.round(totalIndexedTokens / indexedCount) : 0,
      qdrantCollection: QDRANT_COLLECTION,
      qdrantVectorSize: QDRANT_VECTOR_SIZE,
      indexedFolders,
      skippedFiles,
    });

    return NextResponse.json({
      ok: true,
      collection: QDRANT_COLLECTION,
      indexedCount,
      skippedCount: skippedFiles.length,
      totalIndexedChars,
      totalIndexedTokens,
      averageIndexedTokensPerFile: indexedCount ? Math.round(totalIndexedTokens / indexedCount) : 0,
      qdrantVectorSize: QDRANT_VECTOR_SIZE,
      indexedFolders,
      skippedFiles,
    });
  } catch (error: any) {
    console.error("/api/generate-rag-context failed:", error);
    return NextResponse.json(
      { ok: false, error: error?.message || "Unknown generate-rag-context error" },
      { status: 500 },
    );
  }
}

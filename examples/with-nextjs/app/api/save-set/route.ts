import { Buffer } from "buffer";
import { NextResponse } from "next/server";

import {
  buildTrainingTags,
  saveTrainingExample,
  type TrainingLogRecord,
} from "@/lib/driveTrainingExamples";
import { driveSaveFiles } from "@/lib/driveSaveFiles";
import { GPT_Router } from "@/lib/gptRouter";
import { resolveDriveFolder } from "@/lib/driveSubfolderResolver";
import {
  DRIVE_DOCS_TRAINING_FOLDER_ID,
  DRIVE_FALLBACK_FOLDER_ID,
  PROMPT_SET_NAME_SOURCE,
} from "@/lib/jsonCanonSources";
import { normalizeFilename } from "@/lib/normalizeFilename";

interface SelectedSubfolderMeta {
  topic: string;
  folderId?: string;
}

const extractSummaryField = (summary: string, label: string) =>
  summary.match(new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, "imu"))?.[1]?.trim() || "";

const buildFolderPath = (slugOrPath: string, base: string) => {
  if (!slugOrPath) return base;
  if (slugOrPath.startsWith(`${base}/`) || slugOrPath === base) return slugOrPath;
  if (slugOrPath.includes("/")) return slugOrPath;
  return `${base}/${slugOrPath}`;
};

const mimeTypeByExtension: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const resolveExtension = (fileName: string, fallback: string) => {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension && extension.length ? extension : fallback;
};

const resolveMimeType = (file: File, fallbackExtension: string) => {
  if (file.type) return file.type;
  const extension = resolveExtension(file.name, fallbackExtension);
  return mimeTypeByExtension[extension] ?? "application/octet-stream";
};

const summariesDiffer = (left: string, right: string) =>
  left.replace(/\s+/g, " ").trim() !== right.replace(/\s+/g, " ").trim();

function buildMarkdown(params: { setName: string; summary: string; imageFiles: File[] }) {
  const { setName, summary, imageFiles } = params;
  const images = imageFiles.map((file, idx) => {
    const pageNumber = idx + 1;
    const extension = resolveExtension(file.name, "jpeg");
    return `![${setName}-p${pageNumber}](./${setName}-p${pageNumber}.${extension})`;
  });

  return `# ${setName}

## summary

${summary.trim()}

---

## support

${images.join("\n\n")}
`;
}

export const runtime = "nodejs";

const PROMPT_ID = PROMPT_SET_NAME_SOURCE;
const BASE_DRIVE_FOLDER_ID = DRIVE_FALLBACK_FOLDER_ID;
const ROOT_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

async function deriveSetNameFromSummary(summary: string): Promise<string> {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fallbackTitle = "document";

  try {
    const systemPrompt = await GPT_Router.getSystemPrompt(PROMPT_ID);
    const userPrompt = await GPT_Router.getUserPrompt(PROMPT_ID, {
      summary,
      wordTarget: 150,
    });

    const label = await GPT_Router.getChatCompletionText({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 64,
    });

    const safeLabel =
      label
        .trim()
        .replace(/[\\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || fallbackTitle;

    return `${safeLabel}-${datePart}`;
  } catch (err) {
    console.error("deriveSetNameFromSummary failed:", err);
    return `${fallbackTitle}-${datePart}`;
  }
}

export async function POST(request: Request) {
  if (!ROOT_DRIVE_FOLDER_ID && !BASE_DRIVE_FOLDER_ID) {
    return NextResponse.json({ error: "Missing DRIVE_FOLDER_ID" }, { status: 500 });
  }

  try {
    const formData = await request.formData();
    const summary = (formData.get("summary") as string | null)?.trim() ?? "";
    const draftSummary = (formData.get("draftSummary") as string | null)?.trim() ?? "";
    const trainingSummary = (formData.get("trainingSummary") as string | null)?.trim() ?? "";
    const selectedSubfolderRaw = formData.get("selectedSubfolder");

    let selectedSubfolder: SelectedSubfolderMeta | null = null;

    if (typeof selectedSubfolderRaw === "string") {
      try {
        selectedSubfolder = (JSON.parse(selectedSubfolderRaw) as SelectedSubfolderMeta) ?? null;
      } catch (err) {
        console.warn("Unable to parse selectedSubfolder from request:", err);
      }
    }

    const files = formData.getAll("files").filter((file): file is File => file instanceof File);

    if (!summary || !files.length) {
      return NextResponse.json({ error: "Summary and files are required." }, { status: 400 });
    }

    const setName = await deriveSetNameFromSummary(summary);
    const normalizedSetName = normalizeFilename(setName);

    const baseFolderId = ROOT_DRIVE_FOLDER_ID || BASE_DRIVE_FOLDER_ID;
    if (!baseFolderId) {
      return NextResponse.json({ error: "Missing DRIVE_FOLDER_ID" }, { status: 500 });
    }

    let targetFolderId: string;
    let topic: string | null = null;

    if (selectedSubfolder) {
      targetFolderId = buildFolderPath(
        selectedSubfolder.folderId || selectedSubfolder.topic,
        baseFolderId,
      );
      topic = selectedSubfolder.topic;
    } else {
      const resolved = await resolveDriveFolder(summary);
      targetFolderId = resolved.folderId;
      topic = resolved.topic;
    }

    const imageFiles = files;
    const markdown = buildMarkdown({
      setName: normalizedSetName,
      summary,
      imageFiles,
    });

    const summaryFile = new File([markdown], "summary.md", { type: "text/markdown" });
    const uploadFiles = [...imageFiles, summaryFile];

    await driveSaveFiles({
      folderId: targetFolderId,
      files: uploadFiles,
      fileToUpload: async (file) => {
        const baseName = normalizeFilename(normalizedSetName.replace(/[\\/:*?"<>|]/g, "_"));
        const extension = resolveExtension(file.name, "dat");

        const fileName = normalizeFilename(
          file === summaryFile || file.name === "summary.md"
            ? `${baseName}.md`
            : `${baseName}-p${imageFiles.indexOf(file) + 1}.${extension ?? "dat"}`,
        );

        return {
          name: fileName,
          buffer: Buffer.from(await file.arrayBuffer()),
          mimeType: resolveMimeType(file, extension),
        };
      },
    });

    const shouldSaveTrainingLog =
      Boolean(DRIVE_DOCS_TRAINING_FOLDER_ID) &&
      (Boolean(trainingSummary) || summariesDiffer(draftSummary, summary));

    if (shouldSaveTrainingLog) {
      try {
        const trainingImages = imageFiles.map((file, idx) => {
          const extension = resolveExtension(file.name, "jpeg");
          const fileName = normalizeFilename(`${normalizedSetName}-p${idx + 1}.${extension}`);
          return new File([file], fileName, { type: resolveMimeType(file, extension) });
        });

        const issuer = extractSummaryField(summary, "單位");
        const docType = extractSummaryField(summary, "類型");
        const action = extractSummaryField(summary, "行動");
        const trainingLog: TrainingLogRecord = {
          originalSummary: draftSummary,
          finalSummary: summary,
          correctionNote: trainingSummary,
          tags: buildTrainingTags(topic, docType, action, selectedSubfolder?.topic),
          images: trainingImages.map((file) => `./${file.name}`),
          issuer,
          docType,
          action,
          createdAt: new Date().toISOString(),
        };

        await saveTrainingExample({
          setName: normalizedSetName,
          log: trainingLog,
          imageFiles: trainingImages,
        });
      } catch (trainingError) {
        console.warn("Unable to persist training log:", trainingError);
      }
    }

    return NextResponse.json({ setName: normalizedSetName, targetFolderId, topic }, { status: 200 });
  } catch (err: any) {
    console.error("save-set failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

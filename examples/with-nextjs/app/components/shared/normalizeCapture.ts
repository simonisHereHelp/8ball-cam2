export type CaptureSource = "camera" | "photos";

export interface NormalizedCapture {
  file: File;
  previewUrl: string;
  source: CaptureSource;
}

export interface NormalizeOptions {
  maxFileSize?: number;
  expectedMimePrefix?: string;
  preferredName?: string;
  maxImageDimension?: number;
  jpegQuality?: number;
}

const DEFAULT_MAX_SIZE = 15 * 1024 * 1024; // 15 MB
const DEFAULT_EXPECTED_PREFIX = "image/";
const DEFAULT_MAX_IMAGE_DIMENSION = 2080;
const DEFAULT_JPEG_QUALITY = 0.72;

export class CaptureError extends Error {}

const createPreviewUrl = (file: File) => {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(file);
  }

  // Fallback for test environments
  return `preview://${file.name}`;
};

async function maybeNormalizeOrientation(file: File): Promise<File> {
  // Some browsers support EXIF-based orientation handling via createImageBitmap.
  if (typeof createImageBitmap !== "function") return file;

  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image" as any,
    });

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, file.type),
    );

    if (!blob) return file;

    return new File([blob], file.name, {
      type: file.type,
      lastModified: Date.now(),
    });
  } catch (err) {
    console.warn("Orientation normalization skipped", err);
    return file;
  }
}

async function loadImageElement(file: File): Promise<HTMLImageElement | null> {
  if (typeof document === "undefined") return null;

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode image."));
      img.src = objectUrl;
    });

    return image;
  } catch (error) {
    console.warn("Image decode skipped", error);
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function maybeDownsizeImage(
  file: File,
  options: {
    maxImageDimension: number;
    jpegQuality: number;
  },
): Promise<File> {
  if (typeof document === "undefined") return file;

  const image = await loadImageElement(file);
  if (!image) return file;

  const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
  const shouldResize = longestEdge > options.maxImageDimension;
  const shouldCompress =
    file.type === "image/jpeg" || file.type === "image/jpg" || file.size > 900 * 1024;

  if (!shouldResize && !shouldCompress) {
    return file;
  }

  const scale = shouldResize ? options.maxImageDimension / longestEdge : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return file;

  ctx.drawImage(image, 0, 0, width, height);

  const outputType = file.type === "image/png" ? "image/jpeg" : file.type || "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      outputType,
      outputType === "image/jpeg" || outputType === "image/webp"
        ? options.jpegQuality
        : undefined,
    ),
  );

  if (!blob || blob.size >= file.size) {
    return file;
  }

  const extension = outputType === "image/jpeg" ? ".jpg" : outputType === "image/webp" ? ".webp" : ".png";
  const nextName = file.name.replace(/\.(png|jpe?g|webp)$/i, extension);

  return new File([blob], nextName === file.name ? file.name : nextName, {
    type: outputType,
    lastModified: Date.now(),
  });
}

export async function normalizeCapture(
  file: File,
  source: CaptureSource,
  options: NormalizeOptions = {},
): Promise<NormalizedCapture> {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_SIZE;
  const expectedMimePrefix = options.expectedMimePrefix ?? DEFAULT_EXPECTED_PREFIX;
  const preferredName = options.preferredName;
  const maxImageDimension = options.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;

  if (!file.type?.startsWith(expectedMimePrefix)) {
    throw new CaptureError("Only image uploads are supported.");
  }

  if (file.size > maxFileSize) {
    throw new CaptureError("Image is too large. Please choose a smaller file.");
  }

  const normalizedName = preferredName ?? (file.name || `image-${Date.now()}.jpg`);
  let workingFile = file;

  // Some browsers strip EXIF orientation when re-encoding; we preserve type here.
  workingFile = await maybeNormalizeOrientation(
    new File([file], normalizedName, {
      type: file.type,
      lastModified: Date.now(),
    }),
  );
  workingFile = await maybeDownsizeImage(workingFile, {
    maxImageDimension,
    jpegQuality,
  });

  const previewUrl = createPreviewUrl(workingFile);

  return {
    file: workingFile,
    previewUrl,
    source,
  };
}

export const DEFAULTS = {
  MAX_FILE_SIZE: DEFAULT_MAX_SIZE,
  MIME_PREFIX: DEFAULT_EXPECTED_PREFIX,
  MAX_IMAGE_DIMENSION: DEFAULT_MAX_IMAGE_DIMENSION,
  JPEG_QUALITY: DEFAULT_JPEG_QUALITY,
};

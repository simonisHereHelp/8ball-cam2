// app/content.tsx
"use client";

import { useState, useEffect } from "react";
import { Camera, Database, Loader2 } from "lucide-react";
import { useSession, signIn, signOut } from "next-auth/react";

import { Button } from "@/ui/components";
import {
  ImageCaptureDialogMobile,
} from "@/app/components";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return isMobile;
}

function Content() {
  const [dialogSource, setDialogSource] = useState<"camera" | "photos" | null>(
    null,
  );
  const [isIndexingQdrant, setIsIndexingQdrant] = useState(false);
  const [qdrantMessage, setQdrantMessage] = useState("");
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    folder: string;
    filename: string;
  } | null>(null);
  const isMobile = useIsMobile();

  const { data: session } = useSession();

  const handleOpen = (source: "camera" | "photos") => setDialogSource(source);
  const handleClose = () => setDialogSource(null);

  const handleQdrant = async () => {
    if (isIndexingQdrant) return;

    setUploadConfirmation(null);
    setQdrantMessage("");
    setIsIndexingQdrant(true);

    try {
      const response = await fetch("/api/generate-rag-context", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            indexedCount?: number;
            skippedCount?: number;
            totalIndexedTokens?: number;
          }
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Unable to generate RAG context.");
      }

      const indexedCount = payload?.indexedCount ?? 0;
      const skippedCount = payload?.skippedCount ?? 0;
      const totalIndexedTokens = payload?.totalIndexedTokens ?? 0;
      setQdrantMessage(
        `Qdrant indexed ${indexedCount} files, skipped ${skippedCount}, approx tokens ${totalIndexedTokens}`,
      );
    } catch (error) {
      console.error("Failed to generate RAG context:", error);
      setQdrantMessage(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Unable to generate RAG context.",
      );
    } finally {
      setIsIndexingQdrant(false);
    }
  };

  useEffect(() => {
    const loadConfirmation = () => {
      const raw = sessionStorage.getItem("uploadConfirmation");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as { folder?: string; filename?: string };
        if (parsed.folder && parsed.filename) {
          setUploadConfirmation({ folder: parsed.folder, filename: parsed.filename });
        }
      } catch (error) {
        console.warn("Unable to parse upload confirmation:", error);
      } finally {
        sessionStorage.removeItem("uploadConfirmation");
      }
    };

    loadConfirmation();

    const handleConfirmation = () => loadConfirmation();
    window.addEventListener("upload-confirmation", handleConfirmation);
    return () => window.removeEventListener("upload-confirmation", handleConfirmation);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Header */}
      <div className="container mx-auto flex flex-col items-center px-4 py-8 h-screen">
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full mb-6">
            <Camera className="w-8 h-8 text-blue-600 dark:text-blue-400" />
          </div>
          <h1 className="text-4xl font-bold text-slate-800 dark:text-slate-100 mb-4">
            文件狗 DocuSniff
          </h1>
          <p className="text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            Google Login(登錄): {session ? "✓" : "❌"}
          </p>
            {!session ? (
              <Button
                onClick={() => signIn("google")}
                className="app-button mt-4"
              >
                <span className="app-button-label">Login</span>
              </Button>
            ) : (
              <Button
                onClick={() => signOut()}
                className="app-button mt-4"
              >
                <span className="app-button-label">Logout</span>
              </Button>
            )}
        </div>

        {/* Main Content */}
        <div className="max-w-4xl flex-1 w-full h-full">
          <div className="bg-white dark:bg-slate-800 h-full flex items-center justify-center rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 p-8 md:p-12">
            <div className="text-center">
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                  <Button
                    onClick={() => handleOpen("camera")}
                    className="app-button h-12 !px-8 !py-3 text-lg font-medium rounded-lg shadow-lg hover:shadow-xl transition-all duration-200 transform hover:scale-105 cursor-pointer"
                  >
                    <Camera className="w-5 h-5 mr-2" />
                    <span className="app-button-label">Launch Camera</span>
                  </Button>
                  <Button
                    onClick={() => handleOpen("photos")}
                    className="app-button h-12 !px-8 !py-3 text-lg font-medium rounded-lg shadow-lg hover:shadow-xl transition-all duration-200 cursor-pointer"
                  >
                    <span className="app-button-label">Photo Album</span>
                  </Button>
                  <Button
                    onClick={handleQdrant}
                    disabled={isIndexingQdrant || !session}
                    className="app-button h-12 !px-8 !py-3 text-lg font-medium rounded-lg shadow-lg hover:shadow-xl transition-all duration-200 cursor-pointer"
                  >
                    {isIndexingQdrant ? (
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    ) : (
                      <Database className="w-5 h-5 mr-2" />
                    )}
                    <span className="app-button-label">Qdrant</span>
                  </Button>
                </div>
                {uploadConfirmation ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400 space-y-1">
                    <p>upload to {uploadConfirmation.folder}</p>
                    <p>filename: {uploadConfirmation.filename}</p>
                  </div>
                ) : qdrantMessage ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {qdrantMessage}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {isMobile
                      ? "Mobile-optimized interface"
                      : "Desktop-enhanced experience"}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {isMobile ? (
        <ImageCaptureDialogMobile
          open={dialogSource !== null}
          onOpenChange={handleClose}
          initialSource={dialogSource ?? "camera"}
        />
      ) : (
        <ImageCaptureDialogMobile
          open={dialogSource !== null}
          onOpenChange={handleClose}
          initialSource={dialogSource ?? "camera"}
        />
      )}
    </div>
  );
}

export default Content;

// @/lib/gptRouter.ts
import fs from "fs/promises";
import path from "path";
import { auth } from "@/auth";

type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "system" | "user" | "assistant";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    };

export class GPT_Router {
  static getChatEndpoint(): string {
    const rawBase =
      process.env.LLAMA_CPP_BASE_URL ||
      process.env.LOCAL_LLM_BASE_URL ||
      "https://lenovo.ishere.help";
    const trimmedBase = rawBase.replace(/\/+$/, "");

    return trimmedBase.endsWith("/v1/chat/completions")
      ? trimmedBase
      : `${trimmedBase}/v1/chat/completions`;
  }

  static getModelName(): string {
    return (
      process.env.LLAMA_CPP_MODEL ||
      process.env.LOCAL_LLM_MODEL ||
      "DeepSeek-R1-Distill-Qwen-7B"
    );
  }

  static getDefaultHeaders(): HeadersInit {
    const apiKey = process.env.LLAMA_CPP_API_KEY || process.env.LOCAL_LLM_API_KEY;

    return apiKey
      ? {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        }
      : {
          "Content-Type": "application/json",
        };
  }

  static async createChatCompletion(params: {
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
  }) {
    const response = await fetch(this.getChatEndpoint(), {
      method: "POST",
      headers: this.getDefaultHeaders(),
      body: JSON.stringify({
        model: this.getModelName(),
        messages: params.messages,
        temperature: params.temperature ?? 0,
        ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Local LLM request failed (${response.status}): ${details || response.statusText}`,
      );
    }

    return response.json();
  }

  static async getChatCompletionText(params: {
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
  }): Promise<string> {
    const data = await this.createChatCompletion(params);
    return data?.choices?.[0]?.message?.content?.trim() || "";
  }

  /**
   * Generic fetch utility: resolve by local path or Drive file ID and parse JSON.
   */
  static async _fetchFile(fileID: string, useAuth: boolean = false): Promise<any> {
    if (!fileID) throw new Error("File ID is required");

    const resolvedPath = this._resolveLocalPath(fileID);

    if (resolvedPath) {
      const fileContent = await fs.readFile(resolvedPath, "utf-8");
      return JSON.parse(fileContent);
    }

    let url = `https://drive.google.com/uc?export=download&id=${fileID}`;
    const headers: HeadersInit = {};

    if (useAuth) {
      const session = await auth();
      const accessToken = (session as any)?.accessToken;
      if (!accessToken) throw new Error("Missing Google Drive access token");

      url = `https://www.googleapis.com/drive/v3/files/${fileID}?alt=media&supportsAllDrives=true`;
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Fetch file ${fileID} failed (Status: ${res.status})`);

    return res.json();
  }

  /**
   * Fetch arbitrary JSON sources using the same ID/path resolution.
   */
  static async fetchJsonSource(source: string, useAuth: boolean = false): Promise<any> {
    return this._fetchFile(source, useAuth);
  }

  /**
   * Get the configured system prompt.
   */
  static async getSystemPrompt(promptFileID: string): Promise<string> {
    const config = await this._fetchFile(promptFileID);
    return config.system;
  }

  /**
   * Build the configured user prompt with canonical data or summary text injected.
   */
  static async getUserPrompt(
    promptFileID: string,
    options: {
      bibleData?: any;
      summary?: string;
      wordTarget?: number;
    },
  ): Promise<string> {
    const config = await this._fetchFile(promptFileID);
    let userPrompt = config.user;
    const { bibleData, summary, wordTarget } = options;

    if (bibleData) {
      const issuerNames = bibleData.issuers?.map((i: any) => i.master) || [];
      const typeNames = bibleData.typeOfDoc?.map((t: any) => t.master) || [];
      const actionNames = bibleData.action?.map((a: any) => a.master) || [];

      const issuerMapping =
        bibleData.issuers?.reduce((acc: any, curr: any) => {
          acc[curr.master] = curr.aliases || [];
          return acc;
        }, {}) || {};

      userPrompt = userPrompt
        .replace("{{ISSUER_NAME}}", JSON.stringify(issuerNames))
        .replace("{{ISSUER_ALIASES}}", JSON.stringify(issuerMapping))
        .replace("{{TYPE_OF_DOC}}", JSON.stringify(typeNames))
        .replace("{{ACTION}}", JSON.stringify(actionNames));
    }

    if (summary) {
      userPrompt = userPrompt.replace("{{SUMMARY}}", summary.trim());
    }

    const finalWordTarget = wordTarget || config.wordTarget || 250;
    userPrompt = userPrompt.replace("{{wordTarget}}", String(finalWordTarget));

    return userPrompt;
  }

  /**
   * Extract the issuer name from a summary using the local DeepSeek-backed endpoint.
   */
  static async getIssuerName(summary: string): Promise<string> {
    const content = await this.getChatCompletionText({
      messages: [
        {
          role: "system",
          content:
            "你是一位精確的實體提取助手。請從提供的摘要中僅提取「寄件單位」或「機構名稱」。只需回傳名稱，不要有標點符號或解釋。如果找不到，請回傳「其他單位」。",
        },
        { role: "user", content: summary },
      ],
      temperature: 0,
    });

    return content || "其他單位";
  }

  static async updateCanonicals(
    fileID: string,
    {
      issuerName,
      issuerAlias,
    }: {
      issuerName: string;
      issuerAlias: string;
    },
  ) {
    const localPath = this._resolveLocalPath(fileID);
    if (localPath) {
      throw new Error(
        "Updating local canonical files is not supported. Provide a Drive file ID via environment variable.",
      );
    }

    const bibleData = await this._fetchFile(fileID, true);

    const masterEntry = bibleData.issuers.find((i: any) => i.master === issuerName);

    if (masterEntry) {
      if (issuerAlias !== issuerName && !masterEntry.aliases.includes(issuerAlias)) {
        masterEntry.aliases.push(issuerAlias);
      } else {
        return { status: "NO_CHANGE", message: "Alias already exists or matches master." };
      }
    } else {
      bibleData.issuers.push({
        master: issuerName,
        aliases: issuerAlias !== issuerName ? [issuerAlias] : [],
      });
    }

    const session = await auth();
    const accessToken = (session as any)?.accessToken;
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileID}?uploadType=media&supportsAllDrives=true`;

    const writeRes = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bibleData, null, 2),
    });

    if (!writeRes.ok) throw new Error("Failed to update Bible file on Drive");
    return { status: "UPDATED", issuerName, issuerAlias };
  }

  private static _resolveLocalPath(source: string) {
    const looksLikeDriveId = /^[a-zA-Z0-9_-]{10,}$/.test(source) && !source.includes("/");
    if (looksLikeDriveId || source.startsWith("http")) return null;

    return path.isAbsolute(source) ? source : path.join(process.cwd(), source);
  }
}

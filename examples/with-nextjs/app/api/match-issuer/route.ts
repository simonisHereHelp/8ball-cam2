import { NextResponse } from "next/server";

import { GPT_Router } from "@/lib/gptRouter";
import { buildHistoryContext, loadSavedSummaryHistory } from "@/lib/historySummarySearch";

export const runtime = "nodejs";

const PROMPT = "你是一位嚴謹的「寄件單位」助理。你只能根據輸入摘要與歷史文件做判斷，不得猜測。你的目標是穩定判斷 editableSummary 中的 Issuer 是否應映射到既有歷史文件中的「寄件單位」名稱。若摘要中的 Issuer 來自醫療、牙醫、診所、帳單、statement、invoice、receipt，優先把發單的醫療提供者視為 Issuer，而不是病人、保險公司或付款人。";

const parseJson = (text: string) => {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned) as {
    matched?: boolean;
    issuerName?: string;
    confidence?: number;
    sourceFile?: string;
  };
};

export async function POST(request: Request) {
  try {
    const { editableSummary } = (await request.json().catch(() => ({}))) as { editableSummary?: string };
    if (!editableSummary?.trim()) {
      return NextResponse.json({ error: "Missing editableSummary" }, { status: 400 });
    }

    const history = await loadSavedSummaryHistory();
    if (!history.length) {
      return NextResponse.json({ matched: false, issuerName: "", confidence: 0, sourceFile: "" });
    }

    const historyContext = buildHistoryContext(editableSummary, history, 20);
    const responseText = await GPT_Router.getChatCompletionText({
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: [
            "請閱讀 editableSummary 與所有歷史文件，比對後找到最接近的 issuer Name。",
            "若沒有足夠證據，matched 應為 false，issuerName 保持空字串。",
            "請只輸出 JSON，不要加入任何額外文字。格式如下：",
            '{"matched":true,"issuerName":"","confidence":0.0,"sourceFile":""}',
            "",
            "editableSummary:",
            editableSummary.trim(),
            "",
            "所有歷史文件:",
            historyContext,
          ].join("\n"),
        },
      ],
      temperature: 0,
      max_tokens: 220,
    });

    const parsed = parseJson(responseText);
    return NextResponse.json({
      matched: Boolean(parsed.matched && parsed.issuerName),
      issuerName: parsed.issuerName?.trim() || "",
      confidence: Number(parsed.confidence) || 0,
      sourceFile: parsed.sourceFile?.trim() || "",
    });
  } catch (error: any) {
    console.error("/api/match-issuer failed:", error);
    return NextResponse.json({ error: error?.message || "Unable to match issuer" }, { status: 500 });
  }
}

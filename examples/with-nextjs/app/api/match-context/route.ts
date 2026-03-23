import { NextResponse } from "next/server";

import { GPT_Router } from "@/lib/gptRouter";
import { buildHistoryContext, loadSavedSummaryHistory } from "@/lib/historySummarySearch";

export const runtime = "nodejs";

const PROMPT = "你是一位嚴謹的「相關文件」助理。你只能根據輸入摘要與歷史文件做判斷，不得猜測。你的目標是根據 editableSummary 中的摘要去判斷本文件的主題與既有歷史文件中有無重疊或相關的主題。例如：文件中如果涉及相同的案件編號、帳號、事件名稱、事件日期、文件編號，則是相關。如果相關文件，請列出歷史文件的文件名，日期。";

const parseJson = (text: string) => {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned) as {
    matches?: Array<{
      fileName?: string;
      date?: string;
      confidence?: number;
    }>;
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
      return NextResponse.json({ matches: [] });
    }

    const historyContext = buildHistoryContext(editableSummary, history, 25);
    const responseText = await GPT_Router.getChatCompletionText({
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: [
            "請閱讀 editableSummary 與所有歷史文件，找出主題重疊或相關的歷史文件。",
            "最多回傳 3 筆。若無明確相關文件，回傳 {\"matches\":[]}。",
            "請只輸出 JSON，不要加入任何額外文字。格式如下：",
            '{"matches":[{"fileName":"","date":"","confidence":0.0}]}',
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
      max_tokens: 260,
    });

    const parsed = parseJson(responseText);
    const matches = Array.isArray(parsed.matches)
      ? parsed.matches
          .filter((item) => item?.fileName)
          .slice(0, 3)
          .map((item, index) => ({
            matchId: index,
            fileName: item.fileName?.trim() || "",
            date: item.date?.trim() || "",
            confidence: Number(item.confidence) || 0,
          }))
      : [];

    return NextResponse.json({ matches });
  } catch (error: any) {
    console.error("/api/match-context failed:", error);
    return NextResponse.json({ error: error?.message || "Unable to match context" }, { status: 500 });
  }
}

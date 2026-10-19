const FEISHU_CHAT_ID_PATTERN = /^oc_[A-Za-z0-9]+$/;

/** Resolve exactly one configured destination for the scheduled daily report. */
export function resolveDailyReportChatId(configuredChatId: string): string {
  const chatId = configuredChatId.trim();
  if (!chatId) {
    throw new Error("FEISHU_REPORT_CHAT_ID is required");
  }
  if (!FEISHU_CHAT_ID_PATTERN.test(chatId)) {
    throw new Error("FEISHU_REPORT_CHAT_ID must contain exactly one valid chat ID");
  }
  return chatId;
}

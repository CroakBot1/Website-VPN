import axios from "axios";

let lastMessageId = null;

export function initTelegramAutoDeleteLite({
  botToken,
  chatId,
  intervalMs = 10000,
}) {
  if (!botToken || !chatId) {
    throw new Error("Missing botToken or chatId");
  }

  // 💡 manual setter (kani ang gamiton sa index.js)
  global.setLastTelegramMessageId = (id) => {
    lastMessageId = id;
  };

  setInterval(async () => {
    if (!lastMessageId) return;

    try {
      await axios.post(
        `https://api.telegram.org/bot${botToken}/deleteMessage`,
        {
          chat_id: chatId,
          message_id: lastMessageId,
        }
      );

      lastMessageId = null;
    } catch (err) {
      console.error(
        "AUTO DELETE ERROR:",
        err.response?.data || err.message
      );
    }
  }, intervalMs);
}

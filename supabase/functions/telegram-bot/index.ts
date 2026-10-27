import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  
  try {
    const body = await req.json()

    // 1. Уведомление об активации (для сайта/приложения)
    if (body.action === 'notify_activation') {
      const { token, app_keys, device_name } = body
      const appsList = Array.isArray(app_keys) ? app_keys.join(', ') : app_keys
      
      // Время по Екатеринбургу (UTC+5)
      const ekbTime = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" });

      const text = `🔔 *Новая активация!*\n\n📦 Приложения: \`${appsList}\`\n🔑 Токен: \`${token}\`\n⏰ Время (Екб): \`${ekbTime}\`\n📱 Устройство: \`${device_name}\``
      
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
        ]
      };

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chat_id: ADMIN_CHAT_ID, 
          text: text, 
          parse_mode: 'Markdown',
          reply_markup: replyMarkup
        })
      })
      
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    // 2. Обработка запросов от Telegram (команда /start и удаление сообщения по кнопке)
    if (body.message) {
      const chatId = body.message.chat.id
      const text = body.message.text
      const isAdmin = String(chatId) === String(ADMIN_CHAT_ID)

      if (text === '/start') {
        const replyMarkup: any = { inline_keyboard: [] }
        if (isAdmin) {
          replyMarkup.inline_keyboard.push([
            { text: "⚙️ Открыть Админ-панель", web_app: { url: "https://apprestore-ios.ru/admin.html" } }
          ])
        }

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chat_id: chatId, 
            text: "👋 Привет! Добро пожаловать в систему управления AppRestore iOS.",
            reply_markup: replyMarkup
          })
        })
      }
    }

    if (body.callback_query) {
      const query = body.callback_query
      if (query.data === 'delete_msg') {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: query.message.chat.id, message_id: query.message.message_id })
        })
      }
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: query.id })
      })
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    return new Response('Error: ' + err.message, { status: 500 })
  }
})

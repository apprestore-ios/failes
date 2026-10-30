import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID') || Deno.env.get('TELEGRAM_ADMIN_ID')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function parseDeviceName(ua: string): string {
  if (!ua) return "iPhone (модель не передана сайтом)";
  if (ua.includes("iPhone")) {
    if (ua.includes("CPU OS 18_")) return "iPhone (модель не определена, iOS 18)";
    if (ua.includes("CPU OS 17_")) return "iPhone (модель не определена, iOS 17)";
    if (ua.includes("CPU OS 16_")) return "iPhone (модель не определена, iOS 16)";
    return "iPhone (модель не определена)";
  }
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "Mac (Safari)";
  if (ua.includes("Windows")) return "Windows PC";
  if (ua.includes("Android")) return "Android устройство";
  return "Мобильное устройство";
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      return new Response(JSON.stringify({ success: false, error: 'TELEGRAM_BOT_TOKEN не настроен' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const body = await req.json()

    // 1. Уведомление об активации (для сайта/приложения)
    if (body.action === 'notify_activation') {
      const { token, app_keys, device_name, device_model } = body
      const appsList = Array.isArray(app_keys) ? app_keys.join(', ') : (app_keys || 'Не указаны')

      const ekbTime = new Date().toLocaleTimeString("ru-RU", { timeZone: "Asia/Yekaterinburg", hour: '2-digit', minute: '2-digit' });

      // Сайт передаёт примерную модель iPhone в device_model.
      // Используем её в приоритете, чтобы не заменять на общее «iPhone».
      const suppliedDeviceModel =
        typeof device_model === 'string' && device_model.trim()
          ? device_model.trim()
          : (typeof device_name === 'string' && device_name.trim() ? device_name.trim() : '');
      const deviceFormatted = suppliedDeviceModel || parseDeviceName('');

      // Пустая строка между каждым пунктом делает уведомление читабельнее.
      const text = `🔔 *Новая активация!*\n\n📦 Приложения: \`${appsList}\`\n\n🔑 Токен: \`${token || 'Не указан'}\`\n\n⏰ Время (Екб): \`${ekbTime}\`\n\n📱 Устройство: \`${deviceFormatted}\``

      const replyMarkup = {
        inline_keyboard: [
          [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
        ]
      };

      if (!ADMIN_CHAT_ID) {
        return new Response(JSON.stringify({ success: false, error: 'ADMIN_CHAT_ID / TELEGRAM_ADMIN_ID не настроен' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          text,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup
        })
      })
      const telegramResult = await telegramResponse.json()
      if (!telegramResponse.ok || !telegramResult.ok) {
        return new Response(JSON.stringify({ success: false, error: 'Telegram sendMessage failed' }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200
      })
    }

    // 2. Обработка запросов от Telegram (команда /start)
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
            text: "ПАНЕЛЬ АДМИНИСТРАТОРА ПРОЕКТА AppRestore IOS!",
            reply_markup: replyMarkup
          })
        })
      }
    }

    // 3. Обработка нажатия на инлайн-кнопку «Удалить уведомление»
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

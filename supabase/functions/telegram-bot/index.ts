import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID') || Deno.env.get('TELEGRAM_ADMIN_ID')

// Подключение к Supabase (используются встроенные переменные окружения Edge Functions или твои данные проекта)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || "https://gwypxcdnefxlhwvtkvkc.supabase.co"
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || "sb_publishable_x-5_3tc8EOyJDb06MH5XWg_bsGu1qfg"
const CLIENT_SITE_URL = "https://apprestore-ios.ru"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function sbFetch(path: string, options: RequestInit = {}) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    })
    if (!res.ok) return null
    const text = await res.text()
    return text ? JSON.parse(text) : { success: true }
  } catch (_e) {
    return null
  }
}

function generateRandomToken(): string {
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)
  return String(10000000 + (array[0] % 90000000))
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

    // 1. Уведомление об активации разовой ссылки
    if (body.action === 'notify_activation') {
      const { token, app_keys, device_name, device_model } = body
      const appsList = Array.isArray(app_keys) ? app_keys.join(', ') : (app_keys || 'Не указаны')

      const ekbTime = new Date().toLocaleTimeString("ru-RU", { timeZone: "Asia/Yekaterinburg", hour: '2-digit', minute: '2-digit' });

      const suppliedDeviceModel =
        typeof device_model === 'string' && device_model.trim()
          ? device_model.trim()
          : (typeof device_name === 'string' && device_name.trim() ? device_name.trim() : '');

      const deviceFormatted = (suppliedDeviceModel || parseDeviceName(''))
        .split(' · ')[0]
        .slice(0, 100);

      const text = `🔔 *Новая активация!*\n\n📦 Приложения: \`${appsList}\`\n\n🔑 Токен: \`${token || 'Не указан'}\`\n\n⏰ Время (Екб): \`${ekbTime}\`\n\n📱 Устройство: \`${deviceFormatted}\``

      const replyMarkup = {
        inline_keyboard: [
          [{ text: "⚙️ Открыть админку", web_app: { url: 'https://apprestore-ios.ru/admin.html' } }],
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

    // 1.1. Уведомление администратору, что клиент запросил логин/пароль или код 2FA
    if (body.action === 'notify_auth_request') {
      const { token, type } = body
      const ekbTime = new Date().toLocaleTimeString("ru-RU", { timeZone: "Asia/Yekaterinburg", hour: '2-digit', minute: '2-digit' });

      let title = type === '2fa' ? '📲 *Запрос кода 2FA!*' : '🔑 *Запрос логина и пароля!*';
      let desc = type === '2fa' ? 'Клиент установил приложения и ожидает 6-значный код 2FA.' : 'Клиент нажал «Я установил» и ожидает выдачу данных Apple ID.';

      const text = `${title}\n\n${desc}\n\n🔗 Токен ссылки: \`${token || 'Не указан'}\`\n⏰ Время (Екб): \`${ekbTime}\``;

      const replyMarkup = {
        inline_keyboard: [
          [{ text: "⚙️ Открыть админку для выдачи", web_app: { url: 'https://apprestore-ios.ru/admin.html' } }],
          [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
        ]
      };

      if (ADMIN_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
          })
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200
      });
    }

    // 2. Уведомление о новом заказе после нажатия «Я оплатил» на сайте
    if (body.action === 'notify_new_order') {
      const { order_id, order_number, app_names, total_price, promo_code, discount } = body
      const appsList = Array.isArray(app_names) && app_names.length > 0
        ? app_names.map((n: string) => `• ${n}`).join('\n')
        : 'Не указаны'

      const ekbTime = new Date().toLocaleTimeString("ru-RU", { timeZone: "Asia/Yekaterinburg", hour: '2-digit', minute: '2-digit' });

      let text = `💳 *Новый заказ ${order_number || ''}!*\n`
      text += `Покупатель нажал «Я оплатил»\n\n`
      text += `📱 *Приложения:*\n${appsList}\n\n`
      if (promo_code) {
        text += `🏷 *Промокод/Скидка:* \`${promo_code}\` (-${discount || 0} ₽)\n`
      }
      text += `💰 *Сумма к оплате:* \`${total_price || 0} ₽\`\n`
      text += `⏰ *Время (Екб):* \`${ekbTime}\`\n`
      text += `📊 *Статус:* ⏳ Ожидает подтверждения`

      const replyMarkup = {
        inline_keyboard: [
          [{ text: "✅ Подтвердить оплату", callback_data: `approve_order:${order_id}` }],
          [{ text: "❌ Оплата не поступила", callback_data: `reject_order:${order_id}` }],
          [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
        ]
      };

      if (!ADMIN_CHAT_ID) {
        return new Response(JSON.stringify({ success: false, error: 'ADMIN_CHAT_ID не настроен' }), {
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

    // 3. Обработка команды /start — только для администратора
    if (body.message) {
      const chatId = body.message.chat.id;
      const text = body.message.text;

      if (typeof text === 'string' && text.startsWith('/start')) {
        if (String(chatId) !== String(ADMIN_CHAT_ID)) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
          });
        }

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'ПАНЕЛЬ АДМИНИСТРАТОРА ПРОЕКТА AppRestore IOS!',
            reply_markup: {
              inline_keyboard: [[
                {
                  text: '⚙️ Открыть Админ-панель',
                  web_app: { url: 'https://apprestore-ios.ru/admin.html' }
                }
              ]]
            }
          })
        });
      }
    }

    // 4. Обработка нажатий на инлайн-кнопки в Telegram-боте
    if (body.callback_query) {
      const query = body.callback_query
      const data = query.data || ''
      const chatId = query.message?.chat?.id
      const messageId = query.message?.message_id
      const originalText = query.message?.text || ''

      // Удаление уведомления
      if (data === 'delete_msg') {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        })
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: query.id })
        })
        return new Response('OK', { status: 200 })
      }

      // Подтверждение оплаты заказа (генерирует ссылку на 15 минут)
      if (data.startsWith('approve_order:')) {
        const orderId = data.split(':')[1]
        const orders = await sbFetch(`orders?id=eq.${orderId}&select=*`)
        
        if (Array.isArray(orders) && orders.length > 0) {
          const order = orders[0]
          let token = order.link_token

          if (!token) {
            token = generateRandomToken()
            const linkRecord = {
              token: token,
              app_keys: order.app_keys || [],
              ttl_minutes: 15,
              is_used: false,
              activated_at: 0,
              device_id: null,
              auth_status: "none",
              created_at: Date.now()
            }
            await sbFetch("app_links", {
              method: "POST",
              headers: { "Prefer": "resolution=merge-duplicates" },
              body: JSON.stringify(linkRecord)
            })
          }

          await sbFetch(`orders?id=eq.${orderId}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: "approved",
              link_token: token,
              updated_at: new Date().toISOString()
            })
          })

          const linkUrl = `${CLIENT_SITE_URL}/?${token}`
          const updatedText = originalText.replace(/📊 Статус: .*/, '📊 Статус: ✅ Оплата подтверждена') + `\n🔗 Ссылка (15 мин): ${linkUrl}`

          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId,
              text: updatedText,
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
                ]
              }
            })
          })

          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: query.id, text: "✅ Оплата подтверждена! Ссылка отправлена клиенту." })
          })
        } else {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: query.id, text: "⚠️ Заказ не найден в базе", show_alert: true })
          })
        }
        return new Response('OK', { status: 200 })
      }

      // Отклонение оплаты заказа
      if (data.startsWith('reject_order:')) {
        const orderId = data.split(':')[1]
        await sbFetch(`orders?id=eq.${orderId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "rejected",
            updated_at: new Date().toISOString()
          })
        })

        const updatedText = originalText.replace(/📊 Статус: .*/, '📊 Статус: ❌ Оплата не поступила')

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: updatedText,
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Все-таки подтвердить оплату", callback_data: `approve_order:${orderId}` }],
                [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
              ]
            }
          })
        })

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: query.id, text: "❌ Отмечено: оплата не поступила" })
        })
        return new Response('OK', { status: 200 })
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

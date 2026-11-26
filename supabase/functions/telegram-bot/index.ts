import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID') || Deno.env.get('TELEGRAM_ADMIN_ID')

// Подключение к Supabase (используются встроенные переменные окружения Edge Functions или твои данные проекта)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || "https://gwypxcdnefxlhwvtkvkc.supabase.co"
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || "sb_publishable_x-5_3tc8EOyJDb06MH5XWg_bsGu1qfg"
const CLIENT_SITE_URL = "https://apprestore-ios.ru"
const ADMIN_URL = `${CLIENT_SITE_URL}/admin.html`

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


// ================= Аккаунт и код: вспомогательные функции =================
const enc = new TextEncoder()

function jsonRes(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  })
}

async function hmacSha256(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Проверяет подпись Telegram WebApp (initData) и что открыл админ-панель именно администратор
async function verifyAdminInitData(initData: unknown): Promise<boolean> {
  if (typeof initData !== 'string' || !initData || !TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return false
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return false
  params.delete('hash')
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = await hmacSha256(enc.encode('WebAppData'), TELEGRAM_BOT_TOKEN)
  const calc = toHex(await hmacSha256(secret, dataCheckString))
  if (calc !== hash) return false
  const authDate = Number(params.get('auth_date') || 0)
  if (!authDate || Date.now() / 1000 - authDate > 3 * 86400) return false
  try {
    const user = JSON.parse(params.get('user') || '{}')
    return String(user.id) === String(ADMIN_CHAT_ID)
  } catch (_e) {
    return false
  }
}

// Находит заказ покупателя по активированной разовой ссылке (то же устройство, срок не истёк, заказ оплачен)
type ActiveOrder = { ok: boolean; reason?: string; token?: string; orderId?: string; orderNumber?: string }

async function resolveActiveOrder(token: unknown, deviceId: unknown): Promise<ActiveOrder> {
  const t = String(token || '').trim()
  const d = String(deviceId || '').trim()
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(t) || !d || d.length > 120) return { ok: false, reason: 'invalid' }

  const links = await sbFetch(`app_links?token=eq.${encodeURIComponent(t)}&select=*`)
  if (!Array.isArray(links) || links.length === 0) return { ok: false, reason: 'invalid' }
  const link = links[0]
  const activatedAt = Number(link.activated_at) || 0
  const ttlMs = (Number(link.ttl_minutes) || 15) * 60 * 1000
  if (!link.is_used || !activatedAt || link.device_id !== d) return { ok: false, reason: 'invalid' }
  if (Date.now() >= activatedAt + ttlMs) return { ok: false, reason: 'expired' }

  const orders = await sbFetch(`orders?link_token=eq.${encodeURIComponent(t)}&select=id,order_number,status`)
  if (!Array.isArray(orders) || orders.length === 0 || orders[0].status !== 'approved') {
    return { ok: false, reason: 'no_order' }
  }
  return { ok: true, token: t, orderId: String(orders[0].id), orderNumber: String(orders[0].order_number || '') }
}

async function getCredRow(orderId: string) {
  const rows = await sbFetch(`order_credentials?order_id=eq.${encodeURIComponent(orderId)}&select=*`)
  if (rows === null) return null
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : {}
}

async function upsertCred(orderId: string, fields: Record<string, unknown>) {
  return await sbFetch('order_credentials?on_conflict=order_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ order_id: orderId, ...fields, updated_at: new Date().toISOString() })
  })
}

function ts(v: unknown): number {
  const n = v ? Date.parse(String(v)) : 0
  return Number.isFinite(n) ? n : 0
}

// none — код не просили, requested — покупатель ждёт код, ready — код выдан
function codeState(row: Record<string, unknown>): 'none' | 'requested' | 'ready' {
  const req = ts(row.code_requested_at)
  const upd = ts(row.code_updated_at)
  if (row.acc_code && upd >= req) return 'ready'
  if (req && req > upd) return 'requested'
  return 'none'
}

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
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

    // ================= Аккаунт и код (ручная выдача через админку) =================
    // Покупатель: получить логин, пароль и код своего заказа
    if (body.action === 'get_credentials') {
      const ctx = await resolveActiveOrder(body.token, body.device_id)
      if (!ctx.ok) return jsonRes({ success: false, reason: ctx.reason })
      const row = await getCredRow(ctx.orderId!)
      if (row === null) return jsonRes({ success: false, reason: 'server' })
      const state = codeState(row)
      const ready = !!(row.acc_login && row.acc_password)
      return jsonRes({
        success: true,
        ready,
        login: ready ? row.acc_login : '',
        password: ready ? row.acc_password : '',
        code_state: ready ? state : 'none',
        code: ready && state === 'ready' ? row.acc_code : ''
      })
    }

    // Покупатель: нажал «Запросить код» — админу приходит уведомление
    if (body.action === 'request_code') {
      const ctx = await resolveActiveOrder(body.token, body.device_id)
      if (!ctx.ok) return jsonRes({ success: false, reason: ctx.reason })
      const row = await getCredRow(ctx.orderId!)
      if (row === null || !row.acc_login) return jsonRes({ success: false, reason: 'no_credentials' })

      const lastReq = ts(row.code_requested_at)
      const pending = codeState(row) === 'requested'
      if (pending && Date.now() - lastReq < 20000) return jsonRes({ success: true, throttled: true })

      const saved = await upsertCred(ctx.orderId!, { code_requested_at: new Date().toISOString() })
      if (saved === null) return jsonRes({ success: false, reason: 'server' })

      if (ADMIN_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `🔐 Покупатель ждёт код\n\nЗаказ ${ctx.orderNumber}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: '⚙️ Ввести код', web_app: { url: `${ADMIN_URL}?issue=${ctx.token}` } }],
                [{ text: '🗑 Удалить уведомление', callback_data: 'delete_msg' }]
              ]
            }
          })
        }).catch(() => {})
      }
      return jsonRes({ success: true })
    }

    // Админ: все действия ниже требуют подпись Telegram WebApp и совпадение ID администратора
    if (typeof body.action === 'string' && body.action.startsWith('admin_')) {
      if (!(await verifyAdminInitData(body.init_data))) {
        return jsonRes({ success: false, error: 'unauthorized' }, 401)
      }

      // Список заказов с флагами (без паролей) — для значков в админке
      if (body.action === 'admin_credentials_list') {
        const rows = await sbFetch('order_credentials?select=order_id,acc_login,acc_code,code_requested_at,code_updated_at')
        if (rows === null) return jsonRes({ success: false, error: 'server' }, 500)
        const items = (Array.isArray(rows) ? rows : []).map((r: Record<string, unknown>) => ({
          order_id: r.order_id,
          has_login: !!r.acc_login,
          code_state: codeState(r)
        }))
        return jsonRes({ success: true, items })
      }

      const orderId = cleanStr(String(body.order_id ?? ''), 40)
      if (!/^\d{1,20}$/.test(orderId)) return jsonRes({ success: false, error: 'bad_order_id' }, 400)

      // Данные одного заказа для окна выдачи
      if (body.action === 'admin_get_credentials') {
        const row = await getCredRow(orderId)
        if (row === null) return jsonRes({ success: false, error: 'server' }, 500)
        return jsonRes({
          success: true,
          login: row.acc_login || '',
          password: row.acc_password || '',
          code: row.acc_code || '',
          code_state: codeState(row)
        })
      }

      // Выдать логин и пароль (старый код при этом сбрасывается — аккаунт новый)
      if (body.action === 'admin_set_credentials') {
        const login = cleanStr(body.login, 200)
        const password = cleanStr(body.password, 200)
        if (!login || !password) return jsonRes({ success: false, error: 'empty' }, 400)
        const saved = await upsertCred(orderId, { acc_login: login, acc_password: password, acc_code: null, code_updated_at: null })
        if (saved === null) return jsonRes({ success: false, error: 'server' }, 500)
        return jsonRes({ success: true })
      }

      // Отправить код покупателю
      if (body.action === 'admin_set_code') {
        const code = cleanStr(body.code, 64)
        if (!code) return jsonRes({ success: false, error: 'empty' }, 400)
        const saved = await upsertCred(orderId, { acc_code: code, code_updated_at: new Date().toISOString() })
        if (saved === null) return jsonRes({ success: false, error: 'server' }, 500)
        return jsonRes({ success: true })
      }

      return jsonRes({ success: false, error: 'unknown_action' }, 400)
    }

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

      const safeToken = typeof token === 'string' || typeof token === 'number' ? String(token) : ''
      const activationRows: unknown[][] = []
      if (/^[A-Za-z0-9_-]{1,32}$/.test(safeToken)) {
        activationRows.push([{ text: "🔑 Выдать аккаунт", web_app: { url: `${ADMIN_URL}?issue=${safeToken}` } }])
      }
      activationRows.push([{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }])
      const replyMarkup = { inline_keyboard: activationRows };

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

    // 2. Уведомление о новом заказе после нажатия «Я оплатил» на сайте
    if (body.action === 'notify_new_order') {
      const { order_id, order_number, app_names, total_price, promo_code, discount, promo_discount, bulk_discount } = body
      const appsList = Array.isArray(app_names) && app_names.length > 0
        ? app_names.map((n: string) => `• ${n}`).join('\n')
        : 'Не указаны'

      const ekbTime = new Date().toLocaleTimeString("ru-RU", { timeZone: "Asia/Yekaterinburg", hour: '2-digit', minute: '2-digit' });

      let text = `💳 *Новый заказ ${order_number || ''}!*\n`
      text += `Покупатель нажал «Я оплатил»\n\n`
      text += `📱 *Приложения:*\n${appsList}\n\n`
      
      // Раздельный вывод скидок
      if (promo_code && Number(promo_discount) > 0) {
        text += `🏷 *Промокод:* \`${promo_code}\` (-${promo_discount} ₽)\n`
      }
      if (Number(bulk_discount) > 0) {
        text += `🎁 *Оптовая скидка:* -${bulk_discount} ₽\n`
      }
      // Фоллбэк: если старый клиент не передал раздельные скидки, но передал общую
      if (!promo_code && !Number(bulk_discount) && Number(discount) > 0) {
        text += `🎁 *Скидка:* -${discount} ₽\n`
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

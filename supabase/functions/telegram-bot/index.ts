import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID') || Deno.env.get('TELEGRAM_ADMIN_ID')

// Подключение к Supabase (используются встроенные переменные окружения Edge Functions или твои данные проекта)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || "https://gwypxcdnefxlhwvtkvkc.supabase.co"
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const CLIENT_SITE_URL = "https://apprestore-ios.ru"
const ORDER_CRON_SECRET = Deno.env.get('ORDER_CRON_SECRET') || ''

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


async function sendTelegramMessage(text: string, reply_markup?: unknown) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return false;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML', ...(reply_markup ? { reply_markup } : {}) })
  });
  const result = await response.json().catch(() => ({}));
  return response.ok && result.ok === true;
}

async function logOrderEvent(orderId: number, eventType: string, actorType: string, actorId: string | null, message: string, metadata: Record<string, unknown> = {}) {
  return await sbFetch('order_events', {
    method: 'POST', headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ order_id: orderId, event_type: eventType, actor_type: actorType, actor_id: actorId, message, metadata })
  });
}

async function validateTelegramInitData(initData: string) {
  if (!initData || !TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date') || 0);
  if (!hash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', secretKey, enc.encode(TELEGRAM_BOT_TOKEN));
  const hmacKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckString));
  const calculated = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (calculated !== hash.toLowerCase()) return null;
  try {
    const user = JSON.parse(params.get('user') || '{}');
    if (String(user.id) !== String(ADMIN_CHAT_ID)) return null;
    return String(user.id);
  } catch (_e) { return null; }
}

async function getOrder(orderId: number) {
  const rows = await sbFetch(`orders?id=eq.${orderId}&select=*`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function grantOrderAccess(order: Record<string, any>, retry = false) {
  const orderId = Number(order.id);
  if (!retry && order.status !== 'approved') return { success: false, error: 'payment_not_confirmed' };
  if (retry && !['check_expired', 'under_review', 'access_granted'].includes(String(order.status))) return { success: false, error: 'invalid_status' };
  const token = generateRandomToken();
  const linkRecord = { token, app_keys: order.app_keys || [], ttl_minutes: 15, is_used: false, activated_at: 0, device_id: null, created_at: Date.now() };
  const inserted = await sbFetch('app_links', { method: 'POST', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(linkRecord) });
  if (inserted === null) return { success: false, error: 'link_create_failed' };
  const settings = await sbFetch('site_settings?key=eq.order_check_duration_seconds&select=value');
  const duration = Math.min(86400, Math.max(30, Number(Array.isArray(settings) && settings[0]?.value) || 60));
  const now = new Date();
  const expires = new Date(now.getTime() + duration * 1000);
  const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'access_granted', link_token: token, access_granted_at: now.toISOString(), check_expires_at: expires.toISOString(), buyer_confirmed_at: null, issue_reported_at: null, updated_at: now.toISOString() }) });
  if (updated === null) return { success: false, error: 'order_update_failed' };
  await logOrderEvent(orderId, retry ? 'access_regranted' : 'access_granted', 'admin', null, retry ? 'Доступ выдан повторно' : 'Доступ предоставлен покупателю', { check_expires_at: expires.toISOString(), duration_seconds: duration });
  await sendTelegramMessage(`🔗 <b>Доступ выдан</b>\nЗаказ: ${order.order_number || orderId}\nСрок проверки: ${duration} сек.\nСсылка создана; таймер запущен.`);
  return { success: true, link_token: token, check_expires_at: expires.toISOString() };
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

    // Защищённая обработка действий из Telegram Web App админ-панели
    if (body.action === 'admin_order_action') {
      const adminId = await validateTelegramInitData(String(body.initData || ''));
      if (!adminId) return new Response(JSON.stringify({ success: false, error: 'admin_auth_failed' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const orderId = Number(body.order_id);
      if (!Number.isSafeInteger(orderId) || orderId <= 0) return new Response(JSON.stringify({ success: false, error: 'invalid_order_id' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const order = await getOrder(orderId);
      if (!order) return new Response(JSON.stringify({ success: false, error: 'order_not_found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      let result: Record<string, unknown> = { success: false, error: 'unknown_operation' };
      const now = new Date().toISOString();
      if (body.operation === 'confirm_payment' && ['pending', 'payment_review', 'rejected'].includes(String(order.status))) {
        const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', updated_at: now }) });
        if (updated !== null) {
          await logOrderEvent(orderId, 'payment_confirmed', 'admin', adminId, 'Оплата подтверждена администратором');
          await sendTelegramMessage(`✅ <b>Оплата подтверждена</b>\nЗаказ: ${order.order_number || orderId}\nСледующий шаг: отдельно выдать доступ в панели.`);
          result = { success: true };
        } else result = { success: false, error: 'database_update_failed' };
      } else if (body.operation === 'reject_payment' && ['pending', 'payment_review', 'approved'].includes(String(order.status))) {
        const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected', updated_at: now }) });
        if (updated !== null) {
          await logOrderEvent(orderId, 'payment_rejected', 'admin', adminId, 'Оплата не подтверждена');
          await sendTelegramMessage(`❌ <b>Оплата не подтверждена</b>\nЗаказ: ${order.order_number || orderId}`);
          result = { success: true };
        } else result = { success: false, error: 'database_update_failed' };
      } else if (body.operation === 'grant_access') {
        result = await grantOrderAccess(order, Boolean(body.retry));
      } else if (body.operation === 'resolve_issue' && ['check_expired', 'under_review'].includes(String(order.status))) {
        const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', updated_at: now }) });
        if (updated !== null) {
          await logOrderEvent(orderId, 'issue_resolved', 'admin', adminId, 'Обращение покупателя отмечено как решённое');
          result = { success: true };
        } else result = { success: false, error: 'database_update_failed' };
      }
      const status = result.success ? 200 : 409;
      return new Response(JSON.stringify(result), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Покупательские действия: сверяем идентификатор устройства с заказом в БД
    if (body.action === 'buyer_order_action') {
      const orderId = Number(body.order_id);
      const deviceId = String(body.device_id || '');
      const linkToken = String(body.link_token || '');
      if (!Number.isSafeInteger(orderId) || orderId <= 0 || !deviceId || !linkToken) return new Response(JSON.stringify({ success: false, error: 'invalid_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const order = await getOrder(orderId);
      if (!order || String(order.device_id || '') !== deviceId || String(order.link_token || '') !== linkToken) return new Response(JSON.stringify({ success: false, error: 'order_not_found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const now = new Date().toISOString();
      if (!['access_granted', 'check_expired'].includes(String(order.status))) return new Response(JSON.stringify({ success: false, error: 'invalid_order_status' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (body.operation === 'confirm_access') {
        const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'buyer_confirmed', buyer_confirmed_at: now, updated_at: now }) });
        if (updated === null) return new Response(JSON.stringify({ success: false }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await logOrderEvent(orderId, 'buyer_confirmed', 'buyer', deviceId, 'Покупатель подтвердил получение доступа');
        await sendTelegramMessage(`✅ <b>Покупатель подтвердил доступ</b>\nЗаказ: ${order.order_number || orderId}`);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (body.operation === 'report_problem') {
        const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'under_review', issue_reported_at: now, updated_at: now }) });
        if (updated === null) return new Response(JSON.stringify({ success: false }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await logOrderEvent(orderId, 'issue_reported', 'buyer', deviceId, 'Покупатель сообщил о проблеме с доступом');
        await sendTelegramMessage(`⚠️ <b>Покупатель сообщил о проблеме</b>\nЗаказ: ${order.order_number || orderId}\nТребуется проверить обращение.`);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: false, error: 'unknown_operation' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Вызов cron-задачей: повторяем отправку уведомлений, пока они не отмечены в order_events
    if (body.action === 'process_expired_notifications') {
      const supplied = req.headers.get('x-order-cron-secret') || '';
      if (!ORDER_CRON_SECRET || supplied !== ORDER_CRON_SECRET) return new Response('Unauthorized', { status: 401 });
      const expired = await sbFetch("orders?status=eq.check_expired&select=id,order_number,check_expires_at");
      let sent = 0;
      if (Array.isArray(expired)) for (const order of expired) {
        const existing = await sbFetch(`order_events?order_id=eq.${order.id}&event_type=eq.expiry_telegram_sent&select=id`);
        if (Array.isArray(existing) && existing.length) continue;
        const ok = await sendTelegramMessage(`⌛ <b>Истекло время проверки доступа</b>\nЗаказ: ${order.order_number || order.id}\nПокупатель всё ещё может сообщить о проблеме; заказ не считается автоматически подтверждённым.`);
        if (ok) {
          await logOrderEvent(Number(order.id), 'expiry_telegram_sent', 'system', null, 'Уведомление об истечении таймера отправлено');
          sent++;
        }
      }
      return new Response(JSON.stringify({ success: true, sent }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
      if (order_id) await logOrderEvent(Number(order_id), 'payment_review_requested', 'buyer', null, 'Покупатель нажал «Я оплатил»')

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200
      })
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
        text += `🏷 *Промокод:* \`${promo_code}\` (-${discount || 0} ₽)\n`
      }
      text += `💰 *Сумма к оплате:* \`${total_price || 0} ₽\`\n`
      text += `⏰ *Время (Екб):* \`${ekbTime}\`\n`
      text += `📊 *Статус:* 🔎 Ожидает проверки оплаты`

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
      if (String(query.from?.id || '') !== String(ADMIN_CHAT_ID || '')) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: query.id, text: 'Нет доступа', show_alert: true }) });
        return new Response('Forbidden', { status: 403 });
      }

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

      // Подтверждение оплаты — без выдачи ссылки
      if (data.startsWith('approve_order:')) {
        const orderId = Number(data.split(':')[1]);
        const order = await getOrder(orderId);
        if (order && ['pending', 'payment_review', 'rejected'].includes(String(order.status))) {
          const updated = await sbFetch(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', updated_at: new Date().toISOString() }) });
          if (updated !== null) {
            await logOrderEvent(orderId, 'payment_confirmed', 'admin', String(query.from.id), 'Оплата подтверждена в Telegram');
            const updatedText = originalText.replace(/📊 Статус: .*/, '📊 Статус: ✅ Оплата подтверждена') + '\n⏭ Следующий шаг: отдельно выдать доступ.';
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: updatedText, reply_markup: { inline_keyboard: [[{ text: '🔗 Выдать доступ', callback_data: `grant_access:${orderId}` }], [{ text: '🗑 Удалить уведомление', callback_data: 'delete_msg' }]] } }) });
            await sendTelegramMessage(`✅ Оплата подтверждена. Заказ ${order.order_number || orderId}. Доступ ещё не выдан.`);
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: query.id, text: 'Оплата подтверждена. Ссылку нужно выдать отдельно.' }) });
          }
        }
        return new Response('OK', { status: 200 });
      }

      if (data.startsWith('grant_access:')) {
        const orderId = Number(data.split(':')[1]);
        const order = await getOrder(orderId);
        if (order) {
          const result = await grantOrderAccess(order);
          const message = result.success ? `🔗 Доступ выдан для заказа ${order.order_number || orderId}. Таймер проверки запущен.` : 'Не удалось выдать доступ. Проверьте статус заказа.';
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: query.id, text: message, show_alert: !result.success }) });
          if (result.success) {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: `${originalText}\n\n🔗 Доступ выдан. Таймер проверки запущен.`, reply_markup: { inline_keyboard: [[{ text: '🗑 Удалить уведомление', callback_data: 'delete_msg' }]] } }) });
          }
        }
        return new Response('OK', { status: 200 });
      }

      // Отклонение оплаты заказа
      if (data.startsWith('reject_order:')) {
        const orderId = data.split(':')[1]
        const order = await getOrder(Number(orderId))
        const updateResult = await sbFetch(`orders?id=eq.${orderId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "rejected", updated_at: new Date().toISOString() })
        })
        if (updateResult !== null) await logOrderEvent(Number(orderId), 'payment_rejected', 'admin', String(query.from.id), 'Оплата не подтверждена в Telegram')

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

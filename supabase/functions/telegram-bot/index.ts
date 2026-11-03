
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// ======================================================
// 1. НАСТРОЙКИ
// ======================================================

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")

const ADMIN_CHAT_ID =
  Deno.env.get("ADMIN_CHAT_ID") ||
  Deno.env.get("TELEGRAM_ADMIN_ID")

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ||
  "https://gwypxcdnefxlhwvtkvkc.supabase.co"

// Для серверных операций используется SERVICE ROLE KEY.
// Никогда не помещай его в HTML или публичный код сайта.
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")

const CLIENT_SITE_URL = "https://apprestore-ios.ru"

const SPIN_INTERVAL_DAYS = 7
const PRIZE_VALIDITY_DAYS = 7

const SPIN_INTERVAL_MS =
  SPIN_INTERVAL_DAYS * 24 * 60 * 60 * 1000

const PRIZE_VALIDITY_MS =
  PRIZE_VALIDITY_DAYS * 24 * 60 * 60 * 1000

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// ======================================================
// 2. ОБЩИЕ ФУНКЦИИ
// ======================================================

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  })
}

function requireTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не настроен")
  }
}

function requireAdmin() {
  if (!ADMIN_CHAT_ID) {
    throw new Error("ADMIN_CHAT_ID не настроен")
  }
}

function requireSupabase() {
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY не настроен")
  }
}

async function sbFetch(
  path: string,
  options: RequestInit = {},
) {
  requireSupabase()

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        "apikey": SUPABASE_KEY!,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    },
  )

  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Supabase error ${response.status}: ${text}`,
    )
  }

  if (!text) {
    return { success: true }
  }

  try {
    return JSON.parse(text)
  } catch {
    return { success: true }
  }
}

async function telegramRequest(
  method: string,
  payload: Record<string, unknown>,
) {
  requireTelegram()

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  )

  const result = await response.json()

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram ${method}: ${JSON.stringify(result)}`,
    )
  }

  return result
}

function generateRandomToken(): string {
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)

  return String(10000000 + (array[0] % 90000000))
}

function parseDeviceName(ua: string): string {
  if (!ua) {
    return "iPhone (модель не передана сайтом)"
  }

  if (ua.includes("iPhone")) {
    if (ua.includes("CPU OS 18_")) {
      return "iPhone (модель не определена, iOS 18)"
    }

    if (ua.includes("CPU OS 17_")) {
      return "iPhone (модель не определена, iOS 17)"
    }

    if (ua.includes("CPU OS 16_")) {
      return "iPhone (модель не определена, iOS 16)"
    }

    return "iPhone (модель не определена)"
  }

  if (ua.includes("iPad")) return "iPad"

  if (
    ua.includes("Macintosh") ||
    ua.includes("Mac OS")
  ) {
    return "Mac (Safari)"
  }

  if (ua.includes("Windows")) return "Windows PC"
  if (ua.includes("Android")) return "Android устройство"

  return "Мобильное устройство"
}

function validDeviceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 200
  )
}

function dateAfter(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString()
}

// ======================================================
// 3. КОЛЕСО ФОРТУНЫ — ПРИЗЫ
// ======================================================

// Общая вероятность: 100%.

const FORTUNE_PRIZES = [
  {
    type: "discount",
    label: "Скидка 50 ₽",
    value: 50,
    weight: 30,
  },
  {
    type: "discount",
    label: "Скидка 70 ₽",
    value: 70,
    weight: 20,
  },
  {
    type: "discount",
    label: "Скидка 100 ₽",
    value: 100,
    weight: 15,
  },
  {
    type: "discount",
    label: "Скидка 150 ₽",
    value: 150,
    weight: 12,
  },
  {
    type: "discount",
    label: "Скидка 200 ₽",
    value: 200,
    weight: 8,
  },
  {
    type: "discount",
    label: "Скидка 250 ₽",
    value: 250,
    weight: 5,
  },
  {
    type: "discount",
    label: "Скидка 300 ₽",
    value: 300,
    weight: 2,
  },
  {
    type: "discount",
    label: "Бонус 50 ₽",
    value: 50,
    weight: 8,
  },
]

// ======================================================
// 4. ПОЛУЧЕНИЕ ПОСЛЕДНЕГО ВРАЩЕНИЯ
// ======================================================

async function getLatestSpin(deviceId: string) {
  const rows = await sbFetch(
    `fortune_spins?device_id=eq.${encodeURIComponent(deviceId)}&select=*&order=created_at.desc&limit=1`,
  )

  if (!Array.isArray(rows) || rows.length === 0) {
    return null
  }

  return rows[0]
}

// ======================================================
// 5. ПРОВЕРКА СОСТОЯНИЯ КОЛЕСА
// ======================================================

async function fortuneStatus(deviceId: string) {
  if (!validDeviceId(deviceId)) {
    return {
      success: false,
      error: "INVALID_DEVICE_ID",
    }
  }

  const latest = await getLatestSpin(deviceId)

  if (!latest) {
    return {
      success: true,
      can_spin: true,
      next_spin_at: null,
      active_bonus: null,
      last_spin: null,
    }
  }

  const now = Date.now()

  const createdAt = new Date(
    latest.created_at,
  ).getTime()

  const expiresAt = new Date(
    latest.expires_at,
  ).getTime()

  const nextSpinAt =
    createdAt + SPIN_INTERVAL_MS

  const activeBonus =
    latest.is_used === false &&
    expiresAt > now
      ? {
          id: latest.id,
          type: latest.prize_type,
          label: latest.prize_label,
          value: Number(latest.prize_value),
          expires_at: latest.expires_at,
        }
      : null

  return {
    success: true,

    can_spin: now >= nextSpinAt,

    next_spin_at: new Date(
      nextSpinAt,
    ).toISOString(),

    active_bonus: activeBonus,

    last_spin: {
      id: latest.id,
      label: latest.prize_label,
      created_at: latest.created_at,
      expires_at: latest.expires_at,
      is_used: latest.is_used,
    },
  }
}

// ======================================================
// 6. ЗАПУСК КОЛЕСА — ЧЕРЕЗ SQL RPC
// ======================================================

async function fortuneSpin(deviceId: string) {
  if (!validDeviceId(deviceId)) {
    return {
      success: false,
      error: "INVALID_DEVICE_ID",
    }
  }

  const result = await sbFetch(
    "rpc/fortune_spin_atomic",
    {
      method: "POST",
      body: JSON.stringify({
        p_device_id: deviceId,
      }),
    },
  )

  if (!result || typeof result !== "object") {
    throw new Error(
      "Не удалось получить результат вращения",
    )
  }

  return result
}

// ======================================================
// 7. ПОЛУЧЕНИЕ АКТИВНОГО БОНУСА
// ======================================================

async function fortuneBonus(deviceId: string) {
  const status = await fortuneStatus(deviceId)

  if (!status.success) {
    return status
  }

  return {
    success: true,
    bonus: status.active_bonus,
  }
}

// ======================================================
// 8. ПРИМЕНЕНИЕ ВЫИГРЫША К ЗАКАЗУ
// ======================================================

async function fortuneUse(
  deviceId: string,
  spinId: string,
  orderId: string,
) {
  if (
    !validDeviceId(deviceId) ||
    typeof spinId !== "string" ||
    typeof orderId !== "string" ||
    !spinId.trim() ||
    !orderId.trim()
  ) {
    return {
      success: false,
      error: "INVALID_PARAMETERS",
    }
  }

  const rows = await sbFetch(
    `fortune_spins?id=eq.${encodeURIComponent(spinId)}&device_id=eq.${encodeURIComponent(deviceId)}&select=*&limit=1`,
  )

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      success: false,
      error: "BONUS_NOT_FOUND",
    }
  }

  const spin = rows[0]

  if (spin.is_used) {
    return {
      success: false,
      error: "BONUS_ALREADY_USED",
    }
  }

  if (
    new Date(spin.expires_at).getTime() <= Date.now()
  ) {
    return {
      success: false,
      error: "BONUS_EXPIRED",
    }
  }

  const orders = await sbFetch(
    `orders?id=eq.${encodeURIComponent(orderId)}&select=id,status&limit=1`,
  )

  if (!Array.isArray(orders) || orders.length === 0) {
    return {
      success: false,
      error: "ORDER_NOT_FOUND",
    }
  }

  if (orders[0].status !== "pending") {
    return {
      success: false,
      error: "ORDER_NOT_PENDING",
    }
  }

  const metadata = {
    ...(spin.metadata || {}),
    order_id: orderId,
    used_at: new Date().toISOString(),
  }

  const updated = await sbFetch(
    `fortune_spins?id=eq.${encodeURIComponent(spinId)}&device_id=eq.${encodeURIComponent(deviceId)}&is_used=eq.false`,
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        is_used: true,
        used_at: new Date().toISOString(),
        metadata,
      }),
    },
  )

  if (!Array.isArray(updated) || updated.length === 0) {
    return {
      success: false,
      error: "BONUS_ALREADY_USED",
    }
  }

  return {
    success: true,
    message: "Выигрыш привязан к заказу",
    order_id: orderId,
    bonus: {
      id: spin.id,
      label: spin.prize_label,
      value: Number(spin.prize_value),
    },
  }
}

// ======================================================
// 9. ОСНОВНОЙ ОБРАБОТЧИК
// ======================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    })
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    })
  }

  try {
    const body = await req.json()

    // ==================================================
    // 9.1. КОЛЕСО — ПРОВЕРКА
    // ==================================================

    if (body.action === "fortune_status") {
      return jsonResponse(
        await fortuneStatus(body.device_id),
      )
    }

    // ==================================================
    // 9.2. КОЛЕСО — ВРАЩЕНИЕ
    // ==================================================

    if (body.action === "fortune_spin") {
      const result = await fortuneSpin(
        body.device_id,
      )

      return jsonResponse(
        result,
        result.success ? 200 : 400,
      )
    }

    // ==================================================
    // 9.3. КОЛЕСО — ПОЛУЧЕНИЕ БОНУСА
    // ==================================================

    if (body.action === "fortune_bonus") {
      return jsonResponse(
        await fortuneBonus(body.device_id),
      )
    }

    // ==================================================
    // 9.4. КОЛЕСО — ПРИМЕНЕНИЕ БОНУСА
    // ==================================================

    if (body.action === "fortune_use") {
      const result = await fortuneUse(
        body.device_id,
        body.spin_id,
        body.order_id,
      )

      return jsonResponse(
        result,
        result.success ? 200 : 400,
      )
    }

    // ==================================================
    // 9.5. УВЕДОМЛЕНИЕ ОБ АКТИВАЦИИ
    // ==================================================

    if (body.action === "notify_activation") {
      requireAdmin()

      const {
        token,
        app_keys,
        device_name,
        device_model,
      } = body

      const appsList = Array.isArray(app_keys)
        ? app_keys.join(", ")
        : (app_keys || "Не указаны")

      const ekbTime = new Date().toLocaleTimeString(
        "ru-RU",
        {
          timeZone: "Asia/Yekaterinburg",
          hour: "2-digit",
          minute: "2-digit",
        },
      )

      const suppliedDeviceModel =
        typeof device_model === "string" &&
        device_model.trim()
          ? device_model.trim()
          : (
              typeof device_name === "string" &&
              device_name.trim()
                ? device_name.trim()
                : ""
            )

      const deviceFormatted = (
        suppliedDeviceModel || parseDeviceName("")
      )
        .split(" · ")[0]
        .slice(0, 100)

      const text =
        `🔔 *Новая активация!*\n\n` +
        `📦 Приложения: \`${appsList}\`\n\n` +
        `🔑 Токен: \`${token || "Не указан"}\`\n\n` +
        `⏰ Время (Екб): \`${ekbTime}\`\n\n` +
        `📱 Устройство: \`${deviceFormatted}\``

      await telegramRequest("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🗑 Удалить уведомление",
                callback_data: "delete_msg",
              },
            ],
          ],
        },
      })

      return jsonResponse({
        success: true,
      })
    }

    // ==================================================
    // 9.6. УВЕДОМЛЕНИЕ О НОВОМ ЗАКАЗЕ
    // ==================================================

    if (body.action === "notify_new_order") {
      requireAdmin()

      const {
        order_id,
        order_number,
        app_names,
        total_price,
        promo_code,
        discount,
      } = body

      const appsList =
        Array.isArray(app_names) &&
        app_names.length > 0
          ? app_names
              .map((n: string) => `• ${n}`)
              .join("\n")
          : "Не указаны"

      const ekbTime = new Date().toLocaleTimeString(
        "ru-RU",
        {
          timeZone: "Asia/Yekaterinburg",
          hour: "2-digit",
          minute: "2-digit",
        },
      )

      let text =
        `💳 *Новый заказ ${order_number || ""}!*\n`

      text += "Покупатель нажал «Я оплатил»\n\n"

      text +=
        `📱 *Приложения:*\n${appsList}\n\n`

      if (promo_code) {
        text +=
          `🏷 *Промокод:* \`${promo_code}\` (-${discount || 0} ₽)\n`
      }

      text +=
        `💰 *Сумма к оплате:* \`${total_price || 0} ₽\`\n`

      text +=
        `⏰ *Время (Екб):* \`${ekbTime}\`\n`

      text +=
        "📊 *Статус:* ⏳ Ожидает подтверждения"

      await telegramRequest("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Подтвердить оплату",
                callback_data: `approve_order:${order_id}`,
              },
            ],
            [
              {
                text: "❌ Оплата не поступила",
                callback_data: `reject_order:${order_id}`,
              },
            ],
            [
              {
                text: "🗑 Удалить уведомление",
                callback_data: "delete_msg",
              },
            ],
          ],
        },
      })

      return jsonResponse({
        success: true,
      })
    }

    // ==================================================
    // 9.7. TELEGRAM WEBHOOK — /START
    // ==================================================

    if (body.message) {
      requireTelegram()
      requireAdmin()

      const chatId = body.message.chat.id
      const text = body.message.text

      if (
        typeof text === "string" &&
        text.startsWith("/start")
      ) {
        if (
          String(chatId) !== String(ADMIN_CHAT_ID)
        ) {
          return jsonResponse({
            success: true,
          })
        }

        await telegramRequest("sendMessage", {
          chat_id: chatId,
          text:
            "ПАНЕЛЬ АДМИНИСТРАТОРА ПРОЕКТА AppRestore IOS!",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⚙️ Открыть Админ-панель",
                  web_app: {
                    url:
                      "https://apprestore-ios.ru/admin.html",
                  },
                },
              ],
            ],
          },
        })
      }

      return jsonResponse({
        success: true,
      })
    }

    // ==================================================
    // 9.8. TELEGRAM WEBHOOK — CALLBACK
    // ==================================================

    if (body.callback_query) {
      requireTelegram()
      requireAdmin()

      const query = body.callback_query
      const data = query.data || ""

      const chatId = query.message?.chat?.id
      const messageId =
        query.message?.message_id

      const originalText =
        query.message?.text || ""

      // ----------------------------------------------
      // Удаление уведомления
      // ----------------------------------------------

      if (data === "delete_msg") {
        if (
          String(chatId) !== String(ADMIN_CHAT_ID)
        ) {
          return jsonResponse({
            success: true,
          })
        }

        await telegramRequest("deleteMessage", {
          chat_id: chatId,
          message_id: messageId,
        })

        await telegramRequest("answerCallbackQuery", {
          callback_query_id: query.id,
        })

        return jsonResponse({
          success: true,
        })
      }

      // ----------------------------------------------
      // Подтверждение оплаты
      // ----------------------------------------------

      if (data.startsWith("approve_order:")) {
        if (
          String(chatId) !== String(ADMIN_CHAT_ID)
        ) {
          return jsonResponse({
            success: true,
          })
        }

        const orderId = data.split(":")[1]

        const orders = await sbFetch(
          `orders?id=eq.${encodeURIComponent(orderId)}&select=*`,
        )

        if (
          Array.isArray(orders) &&
          orders.length > 0
        ) {
          const order = orders[0]

          let token = order.link_token

          if (!token) {
            token = generateRandomToken()

            const linkRecord = {
              token,
              app_keys: order.app_keys || [],
              ttl_minutes: 15,
              is_used: false,
              activated_at: 0,
              device_id: null,
              created_at: Date.now(),
            }

            await sbFetch("app_links", {
              method: "POST",
              headers: {
                "Prefer": "resolution=merge-duplicates",
              },
              body: JSON.stringify(linkRecord),
            })
          }

          await sbFetch(
            `orders?id=eq.${encodeURIComponent(orderId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                status: "approved",
                link_token: token,
                updated_at: new Date().toISOString(),
              }),
            },
          )

          const linkUrl =
            `${CLIENT_SITE_URL}/?${token}`

          const updatedText =
            originalText.replace(
              /📊 Статус: .*/,
              "📊 Статус: ✅ Оплата подтверждена",
            ) +
            `\n🔗 Ссылка (15 мин): ${linkUrl}`

          await telegramRequest("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: updatedText,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🗑 Удалить уведомление",
                    callback_data: "delete_msg",
                  },
                ],
              ],
            },
          })

          await telegramRequest(
            "answerCallbackQuery",
            {
              callback_query_id: query.id,
              text:
                "✅ Оплата подтверждена! Ссылка отправлена клиенту.",
            },
          )
        } else {
          await telegramRequest(
            "answerCallbackQuery",
            {
              callback_query_id: query.id,
              text: "⚠️ Заказ не найден в базе",
              show_alert: true,
            },
          )
        }

        return jsonResponse({
          success: true,
        })
      }

      // ----------------------------------------------
      // Отклонение оплаты
      // ----------------------------------------------

      if (data.startsWith("reject_order:")) {
        if (
          String(chatId) !== String(ADMIN_CHAT_ID)
        ) {
          return jsonResponse({
            success: true,
          })
        }

        const orderId = data.split(":")[1]

        await sbFetch(
          `orders?id=eq.${encodeURIComponent(orderId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              status: "rejected",
              updated_at: new Date().toISOString(),
            }),
          },
        )

        const updatedText =
          originalText.replace(
            /📊 Статус: .*/,
            "📊 Статус: ❌ Оплата не поступила",
          )

        await telegramRequest("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: updatedText,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "✅ Все-таки подтвердить оплату",
                  callback_data:
                    `approve_order:${orderId}`,
                },
              ],
              [
                {
                  text: "🗑 Удалить уведомление",
                  callback_data: "delete_msg",
                },
              ],
            ],
          },
        })

        await telegramRequest(
          "answerCallbackQuery",
          {
            callback_query_id: query.id,
            text: "❌ Отмечено: оплата не поступила",
          },
        )

        return jsonResponse({
          success: true,
        })
      }

      await telegramRequest(
        "answerCallbackQuery",
        {
          callback_query_id: query.id,
        },
      )

      return jsonResponse({
        success: true,
      })
    }

    return jsonResponse({
      success: true,
      message: "No action",
    })

  } catch (err) {
    console.error(
      "AppRestore Edge Function error:",
      err,
    )

    return jsonResponse(
      {
        success: false,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      },
      500,
    )
  }
})

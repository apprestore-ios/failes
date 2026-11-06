import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")
const ADMIN_CHAT_ID = Deno.env.get("ADMIN_CHAT_ID") || Deno.env.get("TELEGRAM_ADMIN_ID")

// Подключение к Supabase.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://gwypxcdnefxlhwvtkvkc.supabase.co"
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_x-5_3tc8EOyJDb06MH5XWg_bsGu1qfg"
const CLIENT_SITE_URL = "https://apprestore-ios.ru"

// Код 2FA живёт 5 минут. Таймер проверки приложения запускается на 60 секунд.
const TWOFA_CODE_TTL_MS = 5 * 60 * 1000
const VERIFY_TIMER_MS = 60 * 1000

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// Старые действия используют тот же механизм доступа, что и в исходном коде.
async function sbFetch(path: string, options: RequestInit = {}) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    })
    if (!res.ok) return null
    const text = await res.text()
    return text ? JSON.parse(text) : { success: true }
  } catch (_e) {
    return null
  }
}

// Новые операции с аккаунтами выполняются ТОЛЬКО через service_role.
// Публичный anon/publishable key не имеет доступа к таблицам выдачи.
async function sbSecureFetch(path: string, options: RequestInit = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
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

function generateAccessToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function parseDeviceName(ua: string): string {
  if (!ua) return "iPhone (модель не передана сайтом)"
  if (ua.includes("iPhone")) {
    if (ua.includes("CPU OS 18_")) return "iPhone (модель не определена, iOS 18)"
    if (ua.includes("CPU OS 17_")) return "iPhone (модель не определена, iOS 17)"
    if (ua.includes("CPU OS 16_")) return "iPhone (модель не определена, iOS 16)"

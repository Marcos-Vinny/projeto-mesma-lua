// supabase/functions/daily-moon-push/index.ts
//
// Rodada uma vez por dia via Cron (configurado no painel do Supabase).
// Calcula os destaques da lua de HOJE (mesma lógica do App.jsx, só que em
// Deno) e checa eventos manuais ativos hoje. Se tiver algo especial, manda
// push. Se não tiver nada, não manda nada (não vira spam diário).

import * as Astronomy from "npm:astronomy-engine@2";
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:contato@example.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------- mesma lógica astronômica do App.jsx (portada pra Deno/TS) ----------
const SUPERMOON_MAX_KM = 361000;
const MICROMOON_MIN_KM = 405000;
const TODAY_WINDOW_MS = 18 * 60 * 60 * 1000;

const FULL_MOON_NAMES = [
  "Lua do Lobo", "Lua da Neve", "Lua da Minhoca", "Lua Rosa", "Lua das Flores",
  "Lua do Morango", "Lua do Cervo", "Lua do Esturjão", "Lua da Colheita",
  "Lua do Caçador", "Lua do Castor", "Lua Fria",
];

function moonDistanceKm(date: Date) {
  const vec = Astronomy.GeoVector(Astronomy.Body.Moon, date, true);
  const distAU = Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
  return distAU * Astronomy.KM_PER_AU;
}

function collectQuarterEvents(date: Date, daysBack: number, daysForward: number) {
  const start = new Date(date.getTime() - daysBack * 86400000);
  const end = new Date(date.getTime() + daysForward * 86400000);
  const events: any[] = [];
  let q = Astronomy.SearchMoonQuarter(start);
  let guard = 0;
  while (q.time.date <= end && guard < 40) {
    events.push(q);
    q = Astronomy.NextMoonQuarter(q);
    guard++;
  }
  return events;
}

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

function computeMoonHighlights(date: Date) {
  const quarters = collectQuarterEvents(date, 40, 65);
  const fullMoons = quarters.filter((q) => q.quarter === 2);
  const newMoons = quarters.filter((q) => q.quarter === 0);

  function tagSecondInMonth(list: any[]) {
    const seen: Record<string, number> = {};
    return list.map((q) => {
      const key = monthKey(q.time.date);
      seen[key] = (seen[key] || 0) + 1;
      return { ...q, isSecondInMonth: seen[key] >= 2 };
    });
  }
  const taggedFull = tagSecondInMonth(fullMoons);
  const taggedNew = tagSecondInMonth(newMoons);

  function withSuperMicro(q: any) {
    const dist = moonDistanceKm(q.time.date);
    return {
      date: q.time.date,
      distanceKm: dist,
      isSuper: dist <= SUPERMOON_MAX_KM,
      isMicro: dist >= MICROMOON_MIN_KM,
    };
  }

  const now = date.getTime();
  const nextFullQ =
    taggedFull.find((q) => q.time.date.getTime() >= now) || taggedFull[taggedFull.length - 1];
  const nextNewQ =
    taggedNew.find((q) => q.time.date.getTime() >= now) || taggedNew[taggedNew.length - 1];

  const nextFullMoon = nextFullQ
    ? {
        ...withSuperMicro(nextFullQ),
        isBlueMoon: nextFullQ.isSecondInMonth,
        folkloreName: FULL_MOON_NAMES[nextFullQ.time.date.getUTCMonth()],
      }
    : null;

  const nextNewMoon = nextNewQ
    ? { ...withSuperMicro(nextNewQ), isBlackMoon: nextNewQ.isSecondInMonth }
    : null;

  let nextEclipse: { kind: string; date: Date } | null = null;
  try {
    const ecl = Astronomy.SearchLunarEclipse(date);
    nextEclipse = { kind: ecl.kind, date: ecl.peak.date };
  } catch (_e) {
    nextEclipse = null;
  }

  const todayHighlights: string[] = [];
  if (nextFullMoon && Math.abs(nextFullMoon.date.getTime() - now) <= TODAY_WINDOW_MS) {
    todayHighlights.push(
      nextFullMoon.isSuper ? "Super Lua Cheia 🌕" : nextFullMoon.isMicro ? "Micro Lua 🌕" : "Lua Cheia 🌕"
    );
    if (nextFullMoon.isBlueMoon) todayHighlights.push("Lua Azul 🔵");
  }
  if (nextNewMoon && Math.abs(nextNewMoon.date.getTime() - now) <= TODAY_WINDOW_MS) {
    todayHighlights.push("Lua Nova 🌑");
    if (nextNewMoon.isBlackMoon) todayHighlights.push("Lua Negra ⚫");
  }
  if (nextEclipse && Math.abs(nextEclipse.date.getTime() - now) <= TODAY_WINDOW_MS) {
    const kindPt =
      nextEclipse.kind === "total"
        ? "Eclipse Lunar Total (Lua de Sangue) 🔴"
        : nextEclipse.kind === "partial"
        ? "Eclipse Lunar Parcial 🌘"
        : "Eclipse Lunar Penumbral 🌗";
    todayHighlights.push(kindPt);
  }

  return { todayHighlights };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

Deno.serve(async (_req) => {
  try {
    const now = new Date();
    const { todayHighlights } = computeMoonHighlights(now);
    const messages = [...todayHighlights];

    const today = todayIsoDate();
    const { data: events } = await supabase
      .from("sky_events")
      .select("*")
      .lte("start_date", today)
      .gte("end_date", today);

    (events || []).forEach((ev: any) => messages.push(`☄️ ${ev.name}`));

    if (messages.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: "nada especial hoje" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const title = "O céu de hoje";
    const body = messages.join(" · ");

    const { data: subs } = await supabase.from("push_subscriptions").select("*");

    let sent = 0;
    await Promise.allSettled(
      (subs || []).map(async (s: any) => {
        try {
          await webpush.sendNotification(s.subscription, JSON.stringify({ title, body }));
          sent++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          }
        }
      })
    );

    return new Response(JSON.stringify({ sent, messages }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
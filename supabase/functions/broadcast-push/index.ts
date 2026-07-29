// supabase/functions/broadcast-push/index.ts
//
// Chamada por um Database Webhook do Supabase toda vez que entra uma linha
// nova em "stars" ou "sky_events". Manda push pra todo mundo inscrito.

import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:contato@example.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function buildMessage(table: string, record: any) {
  if (table === "stars") {
    return {
      title: "Nova estrela ✨",
      body: `${record.author || "Alguém"} guardou uma estrela no céu de vocês.`,
    };
  }
  if (table === "sky_events") {
    return {
      title: "Novo evento no céu ☄️",
      body: record.name || "Um novo evento foi cadastrado.",
    };
  }
  return { title: "Mesma Lua", body: "Aconteceu algo novo." };
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    // Formato padrão de Database Webhook do Supabase:
    // { type: "INSERT" | "UPDATE" | "DELETE", table, record, old_record, schema }
    const { table, record, type } = payload;

    if (type !== "INSERT") {
      return new Response(JSON.stringify({ skipped: true, reason: "não é INSERT" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { title, body } = buildMessage(table, record);

    const { data: subs, error } = await supabase.from("push_subscriptions").select("*");
    if (error) throw error;

    let sent = 0;
    await Promise.allSettled(
      (subs || []).map(async (s: any) => {
        try {
          await webpush.sendNotification(s.subscription, JSON.stringify({ title, body }));
          sent++;
        } catch (err: any) {
          // 410/404 = inscrição expirada/revogada no navegador -> remove do banco
          if (err.statusCode === 410 || err.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          }
        }
      })
    );

    return new Response(JSON.stringify({ sent, total: subs?.length || 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
})

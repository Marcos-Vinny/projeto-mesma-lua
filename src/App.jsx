import React, { useState, useEffect, useMemo, useRef } from "react";
import * as Astronomy from "astronomy-engine";
import {
  Star,
  X,
  Pencil,
  Image as ImageIcon,
  Loader2,
  Menu as MenuIcon,
  MapPin,
  Trash2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Sparkles,
  Plus,
  Bell,
} from "lucide-react";
import { supabase } from "./supabaseClient";

// ---------- Design tokens ----------
const NIGHT_DEEP = "#0A0E2A";
const NIGHT_MID = "#141A44";
const NIGHT_SOFT = "#1E2657";
const MOON_COLOR = "#F3E7CE";
const GOLD = "#E7B75F";
const LAVENDER = "#9AA3D6";
const TEXT_SOFT = "#D6D9F2";
const TEXT_DIM = "#7C84B8";
const DANGER = "#D96C6C";

const STARS_TABLE = "stars";
const SKY_EVENTS_TABLE = "sky_events";
const PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";
const PHOTOS_BUCKET = "star-photos";
const NAME_KEY = "mesmalua-my-name";

// Chave pública do Web Push (não é segredo, pode ficar no front). A chave
// PRIVADA fica só no servidor (Supabase Edge Function), nunca aqui.
const VAPID_PUBLIC_KEY =
  "BDtwtVx4VrWHt4yJrNpa7KUpI4Ayu5AyQxtHymxj5jacb2XX4oAPCV1BG9knVOj6HAIBJSGtuLJyd5Ywn1ynurE";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// ---------- Motor astronômico: fase exata + eventos especiais ----------
// Usa a lib astronomy-engine (cálculo real de posição/órbita, sem API externa).

// Limiares populares (não existe definição "oficial" única) pra super/micro lua:
// lua cheia/nova mais perto que isso da Terra = "super"; mais longe = "micro".
const SUPERMOON_MAX_KM = 361000;
const MICROMOON_MIN_KM = 405000;
// Janela angular (graus) pra considerar que a lua está "exatamente" numa fase principal.
const PHASE_EXACT_WINDOW_DEG = 6;
// Janela de tempo pra considerar que um evento (lua cheia, eclipse etc.) é "hoje".
const TODAY_WINDOW_MS = 18 * 60 * 60 * 1000;

// Nomes populares da lua cheia por mês (folclore norte-americano, amplamente
// usado também em português — não tem correspondência oficial sazonal no
// hemisfério sul, mas é o que a maioria dos sites em PT-BR usa mesmo assim).
const FULL_MOON_NAMES = [
  "Lua do Lobo",
  "Lua da Neve",
  "Lua da Minhoca",
  "Lua Rosa",
  "Lua das Flores",
  "Lua do Morango",
  "Lua do Cervo",
  "Lua do Esturjão",
  "Lua da Colheita",
  "Lua do Caçador",
  "Lua do Castor",
  "Lua Fria",
];

function moonDistanceKm(date) {
  const vec = Astronomy.GeoVector(Astronomy.Body.Moon, date, true);
  const distAU = Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
  return distAU * Astronomy.KM_PER_AU;
}

// Estado atual da lua: fase exata (via ângulo eclíptico), iluminação e distância.
function computeMoonNow(date) {
  const illum = Astronomy.Illumination(Astronomy.Body.Moon, date);
  const phaseDeg = Astronomy.MoonPhase(date);
  const isWaxing = phaseDeg < 180;

  const angularDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  let name;
  if (angularDist(phaseDeg, 0) <= PHASE_EXACT_WINDOW_DEG) name = "Lua Nova";
  else if (angularDist(phaseDeg, 90) <= PHASE_EXACT_WINDOW_DEG) name = "Quarto Crescente";
  else if (angularDist(phaseDeg, 180) <= PHASE_EXACT_WINDOW_DEG) name = "Lua Cheia";
  else if (angularDist(phaseDeg, 270) <= PHASE_EXACT_WINDOW_DEG) name = "Quarto Minguante";
  else if (phaseDeg < 90) name = "Lua Crescente";
  else if (phaseDeg < 180) name = "Gibosa Crescente";
  else if (phaseDeg < 270) name = "Gibosa Minguante";
  else name = "Lua Minguante";

  return {
    illumination: illum.phase_fraction,
    isWaxing,
    name,
    distanceKm: moonDistanceKm(date),
  };
}

// Junta os eventos de lua nova (quarter 0) e cheia (quarter 2) num intervalo
// de dias ao redor de `date`, pra poder detectar lua azul/negra por mês.
function collectQuarterEvents(date, daysBack, daysForward) {
  const start = new Date(date.getTime() - daysBack * 86400000);
  const end = new Date(date.getTime() + daysForward * 86400000);
  const events = [];
  let q = Astronomy.SearchMoonQuarter(start);
  let guard = 0;
  while (q.time.date <= end && guard < 40) {
    events.push(q);
    q = Astronomy.NextMoonQuarter(q);
    guard++;
  }
  return events;
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

// Calcula: próxima lua cheia (com selos de super/micro/azul), próxima lua
// nova (com selo de negra), próximo eclipse lunar, próximo perigeu/apogeu,
// e uma lista de "destaques de hoje" pra badges perto da lua.
function computeMoonHighlights(date) {
  const quarters = collectQuarterEvents(date, 40, 65);
  const fullMoons = quarters.filter((q) => q.quarter === 2);
  const newMoons = quarters.filter((q) => q.quarter === 0);

  function tagSecondInMonth(list) {
    const seen = {};
    return list.map((q) => {
      const key = monthKey(q.time.date);
      seen[key] = (seen[key] || 0) + 1;
      return { ...q, isSecondInMonth: seen[key] >= 2 };
    });
  }
  const taggedFull = tagSecondInMonth(fullMoons);
  const taggedNew = tagSecondInMonth(newMoons);

  function withSuperMicro(q) {
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

  let nextEclipse = null;
  try {
    const ecl = Astronomy.SearchLunarEclipse(date);
    nextEclipse = { kind: ecl.kind, date: ecl.peak.date };
  } catch (e) {
    nextEclipse = null;
  }

  let nextApsis = null;
  try {
    const apsis = Astronomy.SearchLunarApsis(date);
    nextApsis = {
      kind: apsis.kind === Astronomy.ApsisKind.Pericenter ? "perigeu" : "apogeu",
      date: apsis.time.date,
      distanceKm: apsis.dist_km,
    };
  } catch (e) {
    nextApsis = null;
  }

  const todayHighlights = [];
  if (nextFullMoon && Math.abs(nextFullMoon.date.getTime() - now) <= TODAY_WINDOW_MS) {
    todayHighlights.push(
      nextFullMoon.isSuper ? "Super Lua Cheia" : nextFullMoon.isMicro ? "Micro Lua" : "Lua Cheia"
    );
    if (nextFullMoon.isBlueMoon) todayHighlights.push("Lua Azul");
  }
  if (nextNewMoon && Math.abs(nextNewMoon.date.getTime() - now) <= TODAY_WINDOW_MS) {
    todayHighlights.push("Lua Nova");
    if (nextNewMoon.isBlackMoon) todayHighlights.push("Lua Negra");
  }
  if (nextEclipse && Math.abs(nextEclipse.date.getTime() - now) <= TODAY_WINDOW_MS) {
    const kindPt =
      nextEclipse.kind === "total"
        ? "Eclipse Lunar Total (Lua de Sangue)"
        : nextEclipse.kind === "partial"
        ? "Eclipse Lunar Parcial"
        : "Eclipse Lunar Penumbral";
    todayHighlights.push(kindPt);
  }

  return { nextFullMoon, nextNewMoon, nextEclipse, nextApsis, todayHighlights };
}

function eclipseKindPt(kind) {
  if (kind === "total") return "Eclipse Total (Lua de Sangue)";
  if (kind === "partial") return "Eclipse Parcial";
  return "Eclipse Penumbral";
}

function formatDateShortPt(d) {
  try {
    return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" }).format(d);
  } catch (e) {
    return d.toLocaleDateString();
  }
}

function formatDatePt(d) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch (e) {
    return d.toLocaleDateString();
  }
}

function timeAgoPt(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffDays = Math.floor((now - then) / 86400000);
  if (diffDays <= 0) return "hoje";
  if (diffDays === 1) return "ontem";
  if (diffDays < 30) return `há ${diffDays} dias`;
  const months = Math.floor(diffDays / 30);
  if (months < 12) return `há ${months} ${months === 1 ? "mês" : "meses"}`;
  const years = Math.floor(months / 12);
  return `há ${years} ${years === 1 ? "ano" : "anos"}`;
}

// yyyy-mm-dd local, pra comparar com as colunas date do Supabase
function todayIsoDate() {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

// ---------- Ícone desenhado de cometa (SVG) ----------
function CometIcon({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="cometTail" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={GOLD} stopOpacity="0" />
          <stop offset="100%" stopColor={GOLD} stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <path
        d="M2 4 C 10 8, 16 14, 22 20"
        stroke="url(#cometTail)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.75"
      />
      <path
        d="M6 2 C 12 7, 17 12, 21 18"
        stroke="url(#cometTail)"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.5"
      />
      <circle cx="24" cy="22" r="4.2" fill={GOLD} />
      <circle cx="24" cy="22" r="4.2" fill={GOLD} opacity="0.35">
        <animate attributeName="r" values="4.2;6;4.2" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY);
    } catch (e) {
      return null;
    }
  });
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [stars, setStars] = useState([]);
  const [composing, setComposing] = useState(null); // {x,y}
  const [composeText, setComposeText] = useState("");
  const [composePhotoFile, setComposePhotoFile] = useState(null);
  const [composePhotoPreview, setComposePhotoPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewingStar, setViewingStar] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [fullscreenSky, setFullscreenSky] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // ---- menu flutuante + lista de estrelas ----
  const [menuOpen, setMenuOpen] = useState(false);
  const [starsListOpen, setStarsListOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [highlightedStarId, setHighlightedStarId] = useState(null);

  // ---- eventos do céu (cometas etc., cadastrados manualmente) ----
  const [skyEvents, setSkyEvents] = useState([]);
  const [skyEventsOpen, setSkyEventsOpen] = useState(false);
  const [cometInfoOpen, setCometInfoOpen] = useState(false);
  const [eventForm, setEventForm] = useState({ name: "", comment: "", start_date: "", end_date: "" });
  const [editingEventId, setEditingEventId] = useState(null);
  const [savingEvent, setSavingEvent] = useState(false);
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState(null);
  const [deletingEventId, setDeletingEventId] = useState(null);
  const [eventFormError, setEventFormError] = useState(null);

  // ---- notificações push ----
  // "unsupported" | "default" | "denied" | "granted" | "subscribing" | "error"
  const [notifStatus, setNotifStatus] = useState("checking");

  // ---- drag-to-pan ----
  const [isPanning, setIsPanning] = useState(false);
  const dragRef = useRef(null);

  const skyRef = useRef(null);
  const skyContainerRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!errorMsg) return;
    const t = setTimeout(() => setErrorMsg(null), 4000);
    return () => clearTimeout(t);
  }, [errorMsg]);

  const moon = useMemo(() => computeMoonNow(new Date()), []);
  const moonHighlights = useMemo(() => computeMoonHighlights(new Date()), []);
  const overlayTranslate = (moon.isWaxing ? 1 : -1) * moon.illumination * 100;

  const todayStr = useMemo(() => todayIsoDate(), []);
  const activeSkyEvent = useMemo(() => {
    return (
      skyEvents.find((ev) => ev.start_date <= todayStr && todayStr <= ev.end_date) || null
    );
  }, [skyEvents, todayStr]);

  const ambientStars = useMemo(() => {
    return Array.from({ length: 36 }, () => ({
      left: Math.random() * 100,
      top: Math.random() * 100,
      size: Math.random() * 1.6 + 0.6,
      delay: Math.random() * 6,
    }));
  }, []);

  // Load stars + subscribe to realtime changes so both partners stay in sync
  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data, error } = await supabase
        .from(STARS_TABLE)
        .select("*")
        .order("created_at", { ascending: true });
      if (!mounted) return;
      if (error) {
        setErrorMsg("Não consegui carregar as estrelas. Confira sua conexão.");
      } else {
        setStars(data || []);
      }
      setLoading(false);
    }
    load();

    const channel = supabase
      .channel("stars-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: STARS_TABLE },
        (payload) => {
          setStars((prev) => {
            if (prev.some((s) => s.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: STARS_TABLE },
        (payload) => {
          setStars((prev) => prev.filter((s) => s.id !== payload.old.id));
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Load sky events (cometas etc.) + realtime
  useEffect(() => {
    let mounted = true;

    async function loadEvents() {
      const { data, error } = await supabase
        .from(SKY_EVENTS_TABLE)
        .select("*")
        .order("start_date", { ascending: true });
      if (!mounted) return;
      if (!error) setSkyEvents(data || []);
    }
    loadEvents();

    const channel = supabase
      .channel("sky-events-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: SKY_EVENTS_TABLE },
        (payload) => {
          setSkyEvents((prev) =>
            prev.some((e) => e.id === payload.new.id) ? prev : [...prev, payload.new]
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: SKY_EVENTS_TABLE },
        (payload) => {
          setSkyEvents((prev) => prev.map((e) => (e.id === payload.new.id ? payload.new : e)));
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: SKY_EVENTS_TABLE },
        (payload) => {
          setSkyEvents((prev) => prev.filter((e) => e.id !== payload.old.id));
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Checa se já tem permissão/inscrição de notificação ao abrir o app
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotifStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setNotifStatus("denied");
      return;
    }
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => (reg ? reg.pushManager.getSubscription() : null))
      .then((sub) => setNotifStatus(sub ? "granted" : "default"))
      .catch(() => setNotifStatus("default"));
  }, []);

  async function enableNotifications() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotifStatus("unsupported");
      return;
    }
    setNotifStatus("subscribing");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotifStatus(permission); // "denied" ou "default"
        return;
      }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      const { error } = await supabase.from(PUSH_SUBSCRIPTIONS_TABLE).upsert(
        {
          endpoint: sub.endpoint,
          subscription: sub.toJSON(),
          owner_name: name,
        },
        { onConflict: "endpoint" }
      );
      if (error) throw error;
      setNotifStatus("granted");
    } catch (e) {
      setNotifStatus("error");
    }
  }

  function submitName(e) {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(NAME_KEY, trimmed);
    } catch (e) {
      // ignore storage errors, keep going in-memory
    }
    setName(trimmed);
    setEditingName(false);
    setNameDraft("");
  }

  // ---- cria a estrela a partir de coordenadas de tela (client X/Y) ----
  function handleSkyClickAt(clientX, clientY) {
    if (composing) return;
    const rect = skyRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    const clampedX = Math.min(98, Math.max(2, x));
    const clampedY = Math.min(98, Math.max(2, y));
    setComposeText("");
    setComposePhotoFile(null);
    setComposePhotoPreview(null);
    setErrorMsg(null);
    setComposing({ x: clampedX, y: clampedY, clientX, clientY });
  }

  // ---- drag-to-pan (mouse e toque, via Pointer Events) ----
  const DRAG_THRESHOLD_MOUSE = 6; // px — abaixo disso, conta como clique
  const DRAG_THRESHOLD_TOUCH = 16; // px — o dedo treme mais que o mouse, então damos mais folga

  function handleSkyPointerDown(e) {
    if (composing) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const uiControl = e.target.closest && e.target.closest("[data-ui-control]");
    if (uiControl) return;

    if (e.pointerType !== "mouse") {
      try {
        e.preventDefault();
      } catch (err) {
        // ignore
      }
    }

    const container = skyContainerRef.current;
    if (!container) return;

    const starEl = e.target.closest && e.target.closest("[data-star-btn]");
    const startedStarId = starEl ? starEl.getAttribute("data-star-id") : null;

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
      startedStarId,
      pointerId: e.pointerId,
      threshold: e.pointerType === "mouse" ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH,
    };

    try {
      container.setPointerCapture(e.pointerId);
    } catch (err) {
      // ignore se o navegador não suportar
    }
    setIsPanning(true);
  }

  function handleSkyPointerMove(e) {
    const drag = dragRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > drag.threshold) {
      drag.moved = true;
    }

    if (drag.moved) {
      const container = skyContainerRef.current;
      if (container) {
        container.scrollLeft = drag.scrollLeft - dx;
        container.scrollTop = drag.scrollTop - dy;
      }
    }
  }

  function endSkyDrag(e) {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsPanning(false);
    if (!drag) return;

    const container = skyContainerRef.current;
    if (container) {
      try {
        container.releasePointerCapture(drag.pointerId);
      } catch (err) {
        // ignore
      }
    }

    if (!drag.moved) {
      if (drag.startedStarId != null) {
        const star = stars.find((s) => String(s.id) === String(drag.startedStarId));
        if (star) setViewingStar(star);
      } else {
        handleSkyClickAt(e.clientX, e.clientY);
      }
    }
  }

  function handleSkyPointerUp(e) {
    endSkyDrag(e);
  }

  function handleSkyPointerCancel() {
    dragRef.current = null;
    setIsPanning(false);
  }

  function handlePhotoPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorMsg("Esse arquivo não é uma imagem.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setErrorMsg("A foto precisa ter menos de 8MB.");
      return;
    }
    setComposePhotoFile(file);
    setComposePhotoPreview(URL.createObjectURL(file));
  }

  async function submitCompose() {
    const text = composeText.trim();
    if ((!text && !composePhotoFile) || !composing) return;
    setSaving(true);
    setErrorMsg(null);

    let photo_url = null;
    try {
      if (composePhotoFile) {
        const ext = composePhotoFile.name.split(".").pop();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from(PHOTOS_BUCKET)
          .upload(path, composePhotoFile);
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage
          .from(PHOTOS_BUCKET)
          .getPublicUrl(path);
        photo_url = publicUrlData.publicUrl;
      }

      const { data, error } = await supabase
        .from(STARS_TABLE)
        .insert({
          x: composing.x,
          y: composing.y,
          message: text || null,
          photo_url,
          author: name,
        })
        .select()
        .single();

      if (error) throw error;
      setStars((prev) =>
        prev.some((s) => s.id === data.id) ? prev : [...prev, data]
      );
    } catch (e) {
      setErrorMsg("Não deu pra guardar essa estrela agora. Tenta de novo.");
    }

    setSaving(false);
    setComposing(null);
    setComposeText("");
    setComposePhotoFile(null);
    setComposePhotoPreview(null);
  }

  // ---- apagar estrela ----
  async function deleteStar(id) {
    setDeletingId(id);
    setErrorMsg(null);

    const { data, error } = await supabase
      .from(STARS_TABLE)
      .delete()
      .eq("id", id)
      .select();

    if (error) {
      setErrorMsg("Não deu pra apagar essa estrela agora. Tenta de novo.");
    } else if (!data || data.length === 0) {
      setErrorMsg(
        "Não tive permissão pra apagar essa estrela (verifica a policy de DELETE no Supabase)."
      );
    } else {
      setStars((prev) => prev.filter((s) => s.id !== id));
      if (viewingStar?.id === id) setViewingStar(null);
    }
    setDeletingId(null);
    setConfirmDeleteId(null);
  }

  async function refreshStars() {
    setRefreshing(true);

    const { data, error } = await supabase
      .from(STARS_TABLE)
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      setErrorMsg("Não consegui atualizar o céu.");
    } else {
      setStars(data || []);
    }

    setRefreshing(false);
  }

  // ---- localizar estrela no céu ----
  function locateStar(star) {
    setStarsListOpen(false);
    setConfirmDeleteId(null);
    const container = skyContainerRef.current;
    const inner = skyRef.current;
    if (container && inner) {
      const targetLeft = (star.x / 100) * inner.offsetWidth - container.clientWidth / 2;
      const targetTop = (star.y / 100) * inner.offsetHeight - container.clientHeight / 2;
      container.scrollTo({
        left: Math.max(0, targetLeft),
        top: Math.max(0, targetTop),
        behavior: "smooth",
      });
    }
    setHighlightedStarId(star.id);
    setTimeout(() => setHighlightedStarId(null), 2200);
  }

  // ---- eventos do céu (cometas etc.) ----
  function openNewEventForm() {
    setEditingEventId(null);
    setEventForm({ name: "", comment: "", start_date: todayStr, end_date: todayStr });
    setEventFormError(null);
  }

  function startEditEvent(ev) {
    setEditingEventId(ev.id);
    setEventForm({
      name: ev.name || "",
      comment: ev.comment || "",
      start_date: ev.start_date || todayStr,
      end_date: ev.end_date || todayStr,
    });
    setEventFormError(null);
  }

  async function submitEventForm(e) {
    e.preventDefault();
    setEventFormError(null);
    const name = eventForm.name.trim();
    if (!name) {
      setEventFormError("Dá um nome pro evento.");
      return;
    }
    if (!eventForm.start_date || !eventForm.end_date) {
      setEventFormError("Preenche as duas datas.");
      return;
    }
    if (eventForm.end_date < eventForm.start_date) {
      setEventFormError("A data final não pode ser antes da inicial.");
      return;
    }

    setSavingEvent(true);
    const payload = {
      name,
      comment: eventForm.comment.trim() || null,
      start_date: eventForm.start_date,
      end_date: eventForm.end_date,
    };

    let error, data;
    if (editingEventId) {
      ({ data, error } = await supabase
        .from(SKY_EVENTS_TABLE)
        .update(payload)
        .eq("id", editingEventId)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from(SKY_EVENTS_TABLE)
        .insert(payload)
        .select()
        .single());
    }

    if (error) {
      setEventFormError("Não deu pra salvar agora. Tenta de novo.");
    } else if (!data) {
      setEventFormError(
        "Salvou, mas não recebi confirmação de volta (verifica as policies de SELECT no Supabase)."
      );
    } else {
      setSkyEvents((prev) => {
        const exists = prev.some((e) => e.id === data.id);
        return exists ? prev.map((e) => (e.id === data.id ? data : e)) : [...prev, data];
      });
      setEditingEventId(null);
      setEventForm({ name: "", comment: "", start_date: "", end_date: "" });
    }
    setSavingEvent(false);
  }

  async function deleteSkyEvent(id) {
    setDeletingEventId(id);
    const { data, error } = await supabase
      .from(SKY_EVENTS_TABLE)
      .delete()
      .eq("id", id)
      .select();
    if (error || !data || data.length === 0) {
      setErrorMsg("Não deu pra apagar esse evento agora.");
    } else {
      setSkyEvents((prev) => prev.filter((e) => e.id !== id));
    }
    setDeletingEventId(null);
    setConfirmDeleteEventId(null);
  }

  const earliestDate = useMemo(() => {
    if (stars.length === 0) return null;
    const min = stars.reduce(
      (acc, s) => Math.min(acc, new Date(s.created_at).getTime()),
      Infinity
    );
    return new Date(min);
  }, [stars]);

  const sortedStarsForList = useMemo(() => {
    return [...stars].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [stars]);

  const sortedEventsForList = useMemo(() => {
    return [...skyEvents].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  }, [skyEvents]);

  if (loading) {
    return (
      <div
        style={{ background: NIGHT_DEEP, color: TEXT_SOFT }}
        className="w-full h-screen flex items-center justify-center font-sans"
      >
        <div className="animate-pulse text-sm tracking-wide">carregando o céu...</div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: `radial-gradient(ellipse at 50% -10%, ${NIGHT_SOFT} 0%, ${NIGHT_DEEP} 55%)`,
        color: TEXT_SOFT,
        fontFamily: "'Work Sans', sans-serif",
      }}
      className="w-full h-screen flex flex-col overflow-hidden relative select-none"
    >
      <style>{`
        @keyframes twinkle { 0%,100% { opacity: 0.25; } 50% { opacity: 0.9; } }
        @media (prefers-reduced-motion: reduce) {
          .twinkle { animation: none !important; }
        }
        .twinkle { animation: twinkle 4s ease-in-out infinite; }
        .no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; width: 0; height: 0; }
      `}</style>

      {/* Name prompt overlay */}
      {(!name || editingName) && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(10,14,42,0.92)" }}
        >
          <form
            onSubmit={submitName}
            className="w-full max-w-xs flex flex-col gap-4 items-center text-center"
          >
            <p
              style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", color: TEXT_SOFT }}
              className="text-2xl"
            >
              Como você se chama?
            </p>
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="seu nome"
              style={{
                background: NIGHT_MID,
                border: `1px solid ${NIGHT_SOFT}`,
                color: TEXT_SOFT,
              }}
              className="w-full rounded-xl px-4 py-3 text-center outline-none focus:ring-2"
            />
            <button
              type="submit"
              style={{ background: GOLD, color: NIGHT_DEEP }}
              className="rounded-full px-6 py-2 font-medium text-sm tracking-wide"
            >
              continuar
            </button>
          </form>
        </div>
      )}

      {/* Header */}
      <div className="px-6 pt-6 pb-2 text-center shrink-0">
        <p
          style={{ color: LAVENDER, fontFamily: "'Space Mono', monospace" }}
          className="text-[10px] tracking-[0.25em] uppercase mb-1"
        >
          um céu pra dois, mesmo longe
        </p>
        <h1
          style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", color: MOON_COLOR }}
          className="text-4xl"
        >
          Mesma Lua
        </h1>
      </div>

      {/* Moon */}
      <div className="flex flex-col items-center shrink-0 py-3 relative">
        <div className="relative">
          <div
            style={{
              width: 108,
              height: 108,
              borderRadius: "50%",
              background: MOON_COLOR,
              boxShadow: `0 0 50px 6px rgba(231,183,95,0.22)`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: NIGHT_DEEP,
                transform: `translateX(${overlayTranslate}%)`,
                transition: "transform 0.6s ease",
              }}
            />
          </div>

          {/* Cometa: só aparece se tiver um evento ativo hoje */}
          {activeSkyEvent && (
            <button
              data-ui-control="true"
              onClick={() => setCometInfoOpen((v) => !v)}
              className="absolute"
              style={{ top: -10, right: -14 }}
              aria-label="ver evento do céu"
            >
              <CometIcon size={30} />
            </button>
          )}

          {activeSkyEvent && cometInfoOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setCometInfoOpen(false)} />
              <div
                className="absolute z-40 w-56 rounded-xl p-3"
                style={{
                  top: -6,
                  left: "calc(100% + 6px)",
                  background: NIGHT_MID,
                  border: `1px solid ${NIGHT_SOFT}`,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}
              >
                <p style={{ color: GOLD }} className="text-sm font-medium mb-1">
                  {activeSkyEvent.name}
                </p>
                {activeSkyEvent.comment && (
                  <p style={{ color: TEXT_SOFT }} className="text-xs leading-snug">
                    {activeSkyEvent.comment}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <p style={{ color: TEXT_SOFT, fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic" }} className="mt-3 text-lg">
          {moon.name}
        </p>
        <p style={{ color: TEXT_DIM, fontFamily: "'Space Mono', monospace" }} className="text-[11px] mt-0.5">
          {Math.round(moon.illumination * 100)}% iluminada · a mesma que ela vê aí
        </p>

        {moonHighlights.todayHighlights.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5 mt-2 px-6">
            {moonHighlights.todayHighlights.map((h, i) => (
              <span
                key={i}
                style={{
                  background: "rgba(231,183,95,0.12)",
                  border: `1px solid ${GOLD}55`,
                  color: GOLD,
                }}
                className="text-[10px] px-2 py-1 rounded-full"
              >
                ✨ {h}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Sky (drag-to-pan: arraste com o mouse/dedo pra mover o céu) */}
      <div
        className={
          fullscreenSky
            ? "fixed inset-0 z-20"
            : "flex-1 relative mx-4 mb-3"
        }
      >
        <div
          ref={skyContainerRef}
          onPointerDown={handleSkyPointerDown}
          onPointerMove={handleSkyPointerMove}
          onPointerUp={handleSkyPointerUp}
          onPointerCancel={handleSkyPointerCancel}
          onPointerLeave={handleSkyPointerCancel}
          className={`absolute inset-0 overflow-auto no-scrollbar ${
            fullscreenSky ? "rounded-none" : "rounded-3xl"
          }`}
          style={{
            border: `1px solid ${NIGHT_SOFT}`,
            touchAction: "none",
            cursor: isPanning ? "grabbing" : "grab",
            background: NIGHT_DEEP,
          }}
        >
          <div
            ref={skyRef}
            className="relative"
            style={{
              width: "180%",
              height: "180%",
              minHeight: "100%",
              minWidth: "100%",
              background: `linear-gradient(180deg, transparent, ${NIGHT_MID}55)`,
            }}
          >
          {ambientStars.map((s, i) => (
            <div
              key={i}
              className="twinkle absolute rounded-full pointer-events-none"
              style={{
                left: `${s.left}%`,
                top: `${s.top}%`,
                width: s.size,
                height: s.size,
                background: TEXT_SOFT,
                animationDelay: `${s.delay}s`,
              }}
            />
          ))}

          {stars.length === 0 && !composing && (
            <p
              style={{ color: TEXT_DIM, fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic" }}
              className="absolute inset-0 flex items-center justify-center text-center px-10 text-lg pointer-events-none"
            >
              toque em qualquer lugar do céu pra guardar a primeira estrela
            </p>
          )}

          {stars.map((s) => {
            const isHighlighted = highlightedStarId === s.id;
            return (
              <button
                key={s.id}
                data-star-btn="true"
                data-star-id={s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setViewingStar(s);
                }}
                className="absolute"
                style={{
                  left: `${s.x}%`,
                  top: `${s.y}%`,
                  transform: `translate(-50%, -50%) scale(${isHighlighted ? 1.9 : 1})`,
                  transition: "transform 0.45s ease",
                  zIndex: isHighlighted ? 5 : 1,
                }}
                aria-label="ver estrela"
              >
                <Star
                  size={16}
                  style={{
                    color: GOLD,
                    fill: GOLD,
                    filter: isHighlighted
                      ? "drop-shadow(0 0 14px rgba(231,183,95,1))"
                      : "drop-shadow(0 0 4px rgba(231,183,95,0.7))",
                  }}
                />
              </button>
            );
          })}
          </div>
        </div>

        {/* Botões de tela cheia e atualizar: fora do container que rola,
            então ficam sempre estáticos no canto, mesmo arrastando o céu. */}
        <div className="absolute top-3 left-3 z-10 flex gap-2">
          <button
            data-ui-control="true"
            onClick={() => setFullscreenSky(!fullscreenSky)}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: "rgba(10,14,42,0.75)",
              border: `1px solid ${NIGHT_SOFT}`,
              color: TEXT_SOFT,
            }}
            aria-label={fullscreenSky ? "sair da tela cheia" : "tela cheia"}
          >
            {fullscreenSky ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            data-ui-control="true"
            onClick={refreshStars}
            disabled={refreshing}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: "rgba(10,14,42,0.75)",
              border: `1px solid ${NIGHT_SOFT}`,
              color: TEXT_SOFT,
            }}
            aria-label="atualizar céu"
          >
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Caixa de compor: posição fixa na tela, sempre clampada pra caber */}
      {composing && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setComposing(null)}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed z-30 w-64 rounded-2xl p-3 flex flex-col gap-2"
            style={{
              left: Math.min(
                Math.max(composing.clientX, 140),
                (typeof window !== "undefined" ? window.innerWidth : 400) - 140
              ),
              top: Math.min(
                Math.max(composing.clientY, 12),
                (typeof window !== "undefined" ? window.innerHeight : 800) - 260
              ),
              transform: "translate(-50%, 0)",
              background: NIGHT_MID,
              border: `1px solid ${NIGHT_SOFT}`,
              boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
            }}
          >
            <textarea
              autoFocus
              value={composeText}
              onChange={(e) => setComposeText(e.target.value)}
              placeholder="o que você quer guardar aqui?"
              rows={3}
              style={{ background: "transparent", color: TEXT_SOFT }}
              className="w-full text-sm outline-none resize-none placeholder:text-[13px]"
            />

            {composePhotoPreview ? (
              <div className="relative">
                <img
                  src={composePhotoPreview}
                  alt="prévia"
                  className="w-full h-28 object-cover rounded-lg"
                />
                <button
                  onClick={() => {
                    setComposePhotoFile(null);
                    setComposePhotoPreview(null);
                  }}
                  className="absolute top-1 right-1 rounded-full p-1"
                  style={{ background: "rgba(10,14,42,0.8)", color: TEXT_SOFT }}
                  aria-label="remover foto"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-xs w-fit px-2 py-1 rounded-lg"
                style={{ color: LAVENDER, border: `1px solid ${NIGHT_SOFT}` }}
              >
                <ImageIcon size={12} /> anexar foto
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoPick}
              className="hidden"
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setComposing(null)}
                style={{ color: TEXT_DIM }}
                className="text-xs px-3 py-1.5"
                disabled={saving}
              >
                cancelar
              </button>
              <button
                onClick={submitCompose}
                disabled={saving}
                style={{ background: GOLD, color: NIGHT_DEEP }}
                className="text-xs px-3 py-1.5 rounded-full font-medium flex items-center gap-1.5 disabled:opacity-60"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                {saving ? "guardando..." : "guardar estrela"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Footer */}
      <div className="px-6 pb-5 pt-1 flex items-center justify-between shrink-0">
        <p style={{ color: TEXT_DIM, fontFamily: "'Space Mono', monospace" }} className="text-[11px]">
          {stars.length} {stars.length === 1 ? "estrela" : "estrelas"}
          {earliestDate ? ` · desde ${formatDatePt(earliestDate)}` : ""}
        </p>
        <button
          onClick={() => {
            setNameDraft(name || "");
            setEditingName(true);
          }}
          style={{ color: TEXT_DIM }}
          className="flex items-center gap-1 text-[11px]"
        >
          <Pencil size={11} /> {name}
        </button>
      </div>

      {errorMsg && (
        <div
          className="absolute bottom-16 left-1/2 -translate-x-1/2 text-xs px-3 py-2 rounded-lg max-w-[80%] text-center"
          style={{ background: NIGHT_MID, color: TEXT_SOFT, border: `1px solid ${NIGHT_SOFT}` }}
          onClick={() => setErrorMsg(null)}
        >
          {errorMsg}
        </div>
      )}

      {/* botão flutuante + menu */}
      {menuOpen && (
        <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
      )}
      <div className="fixed z-40" style={{ right: 20, bottom: 84 }}>
        {menuOpen && (
          <div className="absolute bottom-14 right-0 flex flex-col items-end gap-2">
            {notifStatus !== "granted" && notifStatus !== "unsupported" && (
              <button
                onClick={() => {
                  setMenuOpen(false);
                  enableNotifications();
                }}
                className="flex items-center gap-2 pl-3 pr-4 py-2 rounded-full text-xs font-medium whitespace-nowrap"
                style={{
                  background: NIGHT_MID,
                  color: TEXT_SOFT,
                  border: `1px solid ${NIGHT_SOFT}`,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
                }}
              >
                <Bell size={13} style={{ color: GOLD }} />
                {notifStatus === "subscribing" ? "ativando..." : "ativar notificações"}
              </button>
            )}
            <button
              onClick={() => {
                setMenuOpen(false);
                openNewEventForm();
                setSkyEventsOpen(true);
              }}
              className="flex items-center gap-2 pl-3 pr-4 py-2 rounded-full text-xs font-medium whitespace-nowrap"
              style={{
                background: NIGHT_MID,
                color: TEXT_SOFT,
                border: `1px solid ${NIGHT_SOFT}`,
                boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              }}
            >
              <Sparkles size={13} style={{ color: GOLD }} />
              eventos do céu
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                setStarsListOpen(true);
              }}
              className="flex items-center gap-2 pl-3 pr-4 py-2 rounded-full text-xs font-medium whitespace-nowrap"
              style={{
                background: NIGHT_MID,
                color: TEXT_SOFT,
                border: `1px solid ${NIGHT_SOFT}`,
                boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              }}
            >
              <Star size={13} style={{ color: GOLD, fill: GOLD }} />
              estrelas
            </button>
          </div>
        )}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="menu"
          className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{
            background: GOLD,
            color: NIGHT_DEEP,
            boxShadow: "0 4px 20px rgba(231,183,95,0.35)",
          }}
        >
          {menuOpen ? <X size={20} /> : <MenuIcon size={20} />}
        </button>
      </div>

      {/* modal com a lista de estrelas */}
      {starsListOpen && (
        <div
          className="absolute inset-0 z-40 flex items-end sm:items-center justify-center px-4 pb-4 sm:px-6"
          style={{ background: "rgba(10,14,42,0.85)" }}
          onClick={() => {
            setStarsListOpen(false);
            setConfirmDeleteId(null);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl p-4 flex flex-col"
            style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}`, maxHeight: "78vh" }}
          >
            <div className="flex items-center justify-between mb-3 shrink-0">
              <p
                style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", color: MOON_COLOR }}
                className="text-xl"
              >
                Estrelas
              </p>
              <button
                onClick={() => {
                  setStarsListOpen(false);
                  setConfirmDeleteId(null);
                }}
                style={{ color: TEXT_DIM }}
                aria-label="fechar"
              >
                <X size={16} />
              </button>
            </div>

            <div className="overflow-y-auto flex flex-col gap-2 pr-1">
              {sortedStarsForList.length === 0 && (
                <p style={{ color: TEXT_DIM }} className="text-sm text-center py-6">
                  nenhuma estrela guardada ainda
                </p>
              )}

              {sortedStarsForList.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-xl px-3 py-2"
                  style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
                >
                  <Star size={14} style={{ color: GOLD, fill: GOLD, flexShrink: 0 }} />

                  <div className="flex-1 min-w-0">
                    <p style={{ color: TEXT_SOFT }} className="text-xs truncate">
                      {s.photo_url && "📷 "}
                      {s.message ? s.message : s.photo_url ? "foto" : "sem mensagem"}
                    </p>
                    <p
                      style={{ color: TEXT_DIM, fontFamily: "'Space Mono', monospace" }}
                      className="text-[10px] mt-0.5"
                    >
                      {s.author} · {timeAgoPt(s.created_at)}
                    </p>
                  </div>

                  {confirmDeleteId === s.id ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span style={{ color: TEXT_DIM }} className="text-[10px]">
                        apagar?
                      </span>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        style={{ color: TEXT_DIM }}
                        className="text-[10px] px-1.5 py-1"
                      >
                        não
                      </button>
                      <button
                        onClick={() => deleteStar(s.id)}
                        disabled={deletingId === s.id}
                        style={{ background: DANGER, color: "#fff" }}
                        className="text-[10px] px-2 py-1 rounded-full flex items-center gap-1 disabled:opacity-60"
                      >
                        {deletingId === s.id && <Loader2 size={10} className="animate-spin" />}
                        sim
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => locateStar(s)}
                        aria-label="localizar estrela"
                        style={{ color: LAVENDER }}
                        className="p-1.5 rounded-full"
                      >
                        <MapPin size={14} />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(s.id)}
                        aria-label="apagar estrela"
                        style={{ color: TEXT_DIM }}
                        className="p-1.5 rounded-full"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* modal de eventos do céu (cometas manuais + destaques lunares calculados) */}
      {skyEventsOpen && (
        <div
          className="absolute inset-0 z-40 flex items-end sm:items-center justify-center px-4 pb-4 sm:px-6"
          style={{ background: "rgba(10,14,42,0.85)" }}
          onClick={() => {
            setSkyEventsOpen(false);
            setConfirmDeleteEventId(null);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl p-4 flex flex-col"
            style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}`, maxHeight: "84vh" }}
          >
            <div className="flex items-center justify-between mb-3 shrink-0">
              <p
                style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", color: MOON_COLOR }}
                className="text-xl"
              >
                Eventos do céu
              </p>
              <button
                onClick={() => {
                  setSkyEventsOpen(false);
                  setConfirmDeleteEventId(null);
                }}
                style={{ color: TEXT_DIM }}
                aria-label="fechar"
              >
                <X size={16} />
              </button>
            </div>

            <div className="overflow-y-auto flex flex-col gap-4 pr-1">
              {/* Destaques calculados (automáticos, sem manutenção) */}
              <div className="flex flex-col gap-2">
                <p style={{ color: TEXT_DIM }} className="text-[10px] uppercase tracking-wider">
                  calculado automaticamente
                </p>

                {moonHighlights.nextFullMoon && (
                  <div
                    className="rounded-xl px-3 py-2"
                    style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
                  >
                    <p style={{ color: TEXT_SOFT }} className="text-xs">
                      🌕 Próxima lua cheia: {formatDateShortPt(moonHighlights.nextFullMoon.date)} —{" "}
                      {moonHighlights.nextFullMoon.folkloreName}
                    </p>
                    {(moonHighlights.nextFullMoon.isSuper ||
                      moonHighlights.nextFullMoon.isMicro ||
                      moonHighlights.nextFullMoon.isBlueMoon) && (
                      <p style={{ color: GOLD }} className="text-[10px] mt-1">
                        {moonHighlights.nextFullMoon.isSuper && "Super Lua "}
                        {moonHighlights.nextFullMoon.isMicro && "Micro Lua "}
                        {moonHighlights.nextFullMoon.isBlueMoon && "· Lua Azul"}
                      </p>
                    )}
                  </div>
                )}

                {moonHighlights.nextNewMoon && (
                  <div
                    className="rounded-xl px-3 py-2"
                    style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
                  >
                    <p style={{ color: TEXT_SOFT }} className="text-xs">
                      🌑 Próxima lua nova: {formatDateShortPt(moonHighlights.nextNewMoon.date)}
                    </p>
                    {moonHighlights.nextNewMoon.isBlackMoon && (
                      <p style={{ color: GOLD }} className="text-[10px] mt-1">
                        Lua Negra
                      </p>
                    )}
                  </div>
                )}

                {moonHighlights.nextEclipse && (
                  <div
                    className="rounded-xl px-3 py-2"
                    style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
                  >
                    <p style={{ color: TEXT_SOFT }} className="text-xs">
                      🌘 Próximo eclipse lunar: {formatDateShortPt(moonHighlights.nextEclipse.date)} —{" "}
                      {eclipseKindPt(moonHighlights.nextEclipse.kind)}
                    </p>
                  </div>
                )}

                {moonHighlights.nextApsis && (
                  <div
                    className="rounded-xl px-3 py-2"
                    style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
                  >
                    <p style={{ color: TEXT_SOFT }} className="text-xs">
                      🌙 Próximo {moonHighlights.nextApsis.kind}: {formatDateShortPt(moonHighlights.nextApsis.date)} (
                      {Math.round(moonHighlights.nextApsis.distanceKm).toLocaleString("pt-BR")} km)
                    </p>
                  </div>
                )}
              </div>

              {/* Eventos manuais (cometas etc.) */}
              <div className="flex flex-col gap-2">
                <p style={{ color: TEXT_DIM }} className="text-[10px] uppercase tracking-wider">
                  cadastrados por vocês
                </p>

                {sortedEventsForList.length === 0 && (
                  <p style={{ color: TEXT_DIM }} className="text-xs text-center py-2">
                    nenhum evento cadastrado ainda
                  </p>
                )}

                {sortedEventsForList.map((ev) => (
                  <div
                    key={ev.id}
                    className="rounded-xl px-3 py-2"
                    style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p style={{ color: TEXT_SOFT }} className="text-xs font-medium truncate">
                          ☄️ {ev.name}
                        </p>
                        {ev.comment && (
                          <p style={{ color: TEXT_DIM }} className="text-[11px] mt-0.5">
                            {ev.comment}
                          </p>
                        )}
                        <p
                          style={{ color: TEXT_DIM, fontFamily: "'Space Mono', monospace" }}
                          className="text-[10px] mt-1"
                        >
                          {formatDateShortPt(new Date(ev.start_date + "T12:00:00"))} até{" "}
                          {formatDateShortPt(new Date(ev.end_date + "T12:00:00"))}
                        </p>
                      </div>

                      {confirmDeleteEventId === ev.id ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => setConfirmDeleteEventId(null)}
                            style={{ color: TEXT_DIM }}
                            className="text-[10px] px-1"
                          >
                            não
                          </button>
                          <button
                            onClick={() => deleteSkyEvent(ev.id)}
                            disabled={deletingEventId === ev.id}
                            style={{ background: DANGER, color: "#fff" }}
                            className="text-[10px] px-2 py-1 rounded-full flex items-center gap-1"
                          >
                            {deletingEventId === ev.id && (
                              <Loader2 size={10} className="animate-spin" />
                            )}
                            sim
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => startEditEvent(ev)}
                            aria-label="editar evento"
                            style={{ color: LAVENDER }}
                            className="p-1"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteEventId(ev.id)}
                            aria-label="apagar evento"
                            style={{ color: TEXT_DIM }}
                            className="p-1"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Form de novo evento / edição */}
              <form
                onSubmit={submitEventForm}
                className="flex flex-col gap-2 rounded-xl p-3"
                style={{ background: NIGHT_DEEP, border: `1px solid ${NIGHT_SOFT}` }}
              >
                <p style={{ color: TEXT_DIM }} className="text-[10px] uppercase tracking-wider mb-1">
                  {editingEventId ? "editar evento" : "novo evento"}
                </p>
                <input
                  value={eventForm.name}
                  onChange={(e) => setEventForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="nome (ex: Cometa Halley)"
                  style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}`, color: TEXT_SOFT }}
                  className="w-full rounded-lg px-3 py-2 text-xs outline-none"
                />
                <textarea
                  value={eventForm.comment}
                  onChange={(e) => setEventForm((f) => ({ ...f, comment: e.target.value }))}
                  placeholder="comentário (opcional)"
                  rows={2}
                  style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}`, color: TEXT_SOFT }}
                  className="w-full rounded-lg px-3 py-2 text-xs outline-none resize-none"
                />
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={eventForm.start_date}
                    onChange={(e) => setEventForm((f) => ({ ...f, start_date: e.target.value }))}
                    style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}`, color: TEXT_SOFT }}
                    className="flex-1 rounded-lg px-2 py-2 text-xs outline-none"
                  />
                  <input
                    type="date"
                    value={eventForm.end_date}
                    onChange={(e) => setEventForm((f) => ({ ...f, end_date: e.target.value }))}
                    style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}`, color: TEXT_SOFT }}
                    className="flex-1 rounded-lg px-2 py-2 text-xs outline-none"
                  />
                </div>

                {eventFormError && (
                  <p style={{ color: DANGER }} className="text-[11px]">
                    {eventFormError}
                  </p>
                )}

                <div className="flex justify-end gap-2 mt-1">
                  {editingEventId && (
                    <button
                      type="button"
                      onClick={openNewEventForm}
                      style={{ color: TEXT_DIM }}
                      className="text-xs px-3 py-1.5"
                    >
                      cancelar edição
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={savingEvent}
                    style={{ background: GOLD, color: NIGHT_DEEP }}
                    className="text-xs px-3 py-1.5 rounded-full font-medium flex items-center gap-1.5 disabled:opacity-60"
                  >
                    {savingEvent && <Loader2 size={12} className="animate-spin" />}
                    <Plus size={12} />
                    {editingEventId ? "salvar" : "adicionar"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Star viewer modal */}
      {viewingStar && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center px-6"
          style={{ background: "rgba(10,14,42,0.85)" }}
          onClick={() => setViewingStar(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xs rounded-2xl p-5 relative"
            style={{ background: NIGHT_MID, border: `1px solid ${NIGHT_SOFT}` }}
          >
            <button
              onClick={() => setViewingStar(null)}
              className="absolute top-3 right-3"
              style={{ color: TEXT_DIM }}
              aria-label="fechar"
            >
              <X size={16} />
            </button>
            <Star size={18} style={{ color: GOLD, fill: GOLD, marginBottom: 10 }} />

            {viewingStar.photo_url && (
              <img
                src={viewingStar.photo_url}
                alt="foto guardada"
                className="w-full max-h-56 object-cover rounded-xl mb-4"
              />
            )}

            {viewingStar.message && (
              <div
                className="mb-4 overflow-y-auto whitespace-pre-wrap"
                style={{
                  maxHeight: "220px",
                  overflowWrap: "break-word",
              
                }}
              >
                <p
                  style={{
                    fontFamily: "'Cormorant Garamond', serif",
                    fontStyle: "italic",
                    color: TEXT_SOFT,
                  }}
                  className="text-lg leading-snug"
                >
                  "{viewingStar.message}"
                </p>
              </div>
            )}
            <p style={{ color: TEXT_DIM, fontFamily: "'Space Mono', monospace" }} className="text-[11px] mb-3">
              {viewingStar.author} · {timeAgoPt(viewingStar.created_at)}
            </p>

            {confirmDeleteId === viewingStar.id ? (
              <div className="flex items-center gap-2">
                <span style={{ color: TEXT_DIM }} className="text-xs">
                  apagar esta estrela?
                </span>
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  style={{ color: TEXT_DIM }}
                  className="text-xs px-2 py-1"
                >
                  não
                </button>
                <button
                  onClick={() => deleteStar(viewingStar.id)}
                  disabled={deletingId === viewingStar.id}
                  style={{ background: DANGER, color: "#fff" }}
                  className="text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 disabled:opacity-60"
                >
                  {deletingId === viewingStar.id && <Loader2 size={12} className="animate-spin" />}
                  sim, apagar
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDeleteId(viewingStar.id)}
                style={{ color: TEXT_DIM }}
                className="text-xs flex items-center gap-1.5"
              >
                <Trash2 size={12} /> apagar estrela
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
import React, { useState, useEffect, useMemo, useRef } from "react";
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
const PHOTOS_BUCKET = "star-photos";
const NAME_KEY = "mesmalua-my-name";

// ---------- Moon phase math ----------
function getMoonPhase(date) {
  const synodic = 29.53058867;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
  const diffDays = (date.getTime() - knownNewMoon) / 86400000;
  const age = ((diffDays % synodic) + synodic) % synodic;
  const illumination = (1 - Math.cos((2 * Math.PI * age) / synodic)) / 2;
  const isWaxing = age < synodic / 2;

  let name;
  if (age < 1.84566 || age >= 27.68493) name = "Lua Nova";
  else if (age < 5.53699) name = "Lua Crescente";
  else if (age < 9.22831) name = "Quarto Crescente";
  else if (age < 12.91963) name = "Gibosa Crescente";
  else if (age < 16.61096) name = "Lua Cheia";
  else if (age < 20.30228) name = "Gibosa Minguante";
  else if (age < 23.99361) name = "Quarto Minguante";
  else name = "Lua Minguante";

  return { illumination, isWaxing, name };
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

  const moon = useMemo(() => getMoonPhase(new Date()), []);
  const overlayTranslate = (moon.isWaxing ? 1 : -1) * moon.illumination * 100;

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
  const DRAG_THRESHOLD = 6; // px — abaixo disso, conta como clique/toque

  function handleSkyPointerDown(e) {
    if (composing) return;
    // só arrasta com botão principal do mouse (ou toque/caneta, que não têm "button")
    if (e.pointerType === "mouse" && e.button !== 0) return;

    // FIX: se o toque/clique começou em cima de um controle de UI (botões de
    // tela cheia, atualizar, menu etc.), não inicia o pan nem captura o
    // ponteiro — deixa o próprio onClick do botão cuidar disso.
    const uiControl = e.target.closest && e.target.closest("[data-ui-control]");
    if (uiControl) return;

    const container = skyContainerRef.current;
    if (!container) return;

    // FIX: em vez de só saber "começou numa estrela", guardamos QUAL estrela foi,
    // porque depois do setPointerCapture o onClick nativo do botão não dispara mais.
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

    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
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
        // FIX: como o click nativo não chega mais no botão (pointer capture),
        // abrimos o painel da estrela manualmente aqui.
        const star = stars.find((s) => String(s.id) === String(drag.startedStarId));
        if (star) setViewingStar(star);
      } else {
        // foi um clique/toque no céu vazio -> cria estrela
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
      <div className="flex flex-col items-center shrink-0 py-3">
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
        <p style={{ color: TEXT_SOFT, fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic" }} className="mt-3 text-lg">
          {moon.name}
        </p>
        <p style={{ color: TEXT_DIM, fontFamily: "'Space Mono', monospace" }} className="text-[11px] mt-0.5">
          {Math.round(moon.illumination * 100)}% iluminada · a mesma que ela vê aí
        </p>
      </div>

      {/* Sky (drag-to-pan: arraste com o mouse/dedo pra mover o céu) */}
      <div
        ref={skyContainerRef}
        onPointerDown={handleSkyPointerDown}
        onPointerMove={handleSkyPointerMove}
        onPointerUp={handleSkyPointerUp}
        onPointerCancel={handleSkyPointerCancel}
        onPointerLeave={handleSkyPointerCancel}
        className={`overflow-auto no-scrollbar ${
          fullscreenSky
            ? "fixed inset-0 z-50 rounded-none"
            : "flex-1 relative mx-4 mb-3 rounded-3xl"
        }`}
        style={{
          border: `1px solid ${NIGHT_SOFT}`,
          touchAction: "none",
          cursor: isPanning ? "grabbing" : "grab",
          background: NIGHT_DEEP,
        }}
      >
        {/* Botões de fullscreen e refresh: ficam FORA do skyRef (o div que arrasta),
            como filho direto do container. Assim eles não se movem junto com o pan. */}
        <div className="absolute top-3 right-3 z-20 flex gap-2">
          <button
            data-ui-control="true"
            onClick={(e) => {
              e.stopPropagation();
              setFullscreenSky(!fullscreenSky);
            }}
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
            onClick={(e) => {
              e.stopPropagation();
              refreshStars();
            }}
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
                      {s.message ? s.message : s.photo_url ? "📷 foto sem legenda" : "sem mensagem"}
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
                  wordBreak: "break-all",
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
import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = process.env.SESSION_DIR || "./session";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_VERSION = "1.0.0";
const SEND_INTERVAL_MS = 3000;
const HEARTBEAT_MS = 30000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[bot] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const logger = pino({ level: "silent" });

let sock = null;
let currentStatus = "disconnected";
let connectedPhone = "";
let flushing = false;
let reconnectTimer = null;

async function publishStatus(patch) {
  if (patch.status) currentStatus = patch.status;
  const payload = {
    id: 1,
    bot_version: BOT_VERSION,
    updated_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    ...patch,
  };
  try {
    const { error } = await supabase.from("wa_bot_status").upsert(payload, { onConflict: "id" });
    if (error) console.error("[bot] falha ao publicar status:", error.message);
  } catch (error) {
    console.error("[bot] erro ao publicar status:", error?.message || error);
  }
}

async function logEvent(event, level = "info", detail = {}) {
  try {
    await supabase.from("wa_logs").insert({ event, level, detail });
  } catch (error) {
    console.error("[bot] log:", event, error?.message || error);
  }
}

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  if (message.templateButtonReplyMessage?.selectedDisplayText) return message.templateButtonReplyMessage.selectedDisplayText;
  if (message.ephemeralMessage?.message) return extractText(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return extractText(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return extractText(message.viewOnceMessageV2.message);
  return "";
}

async function forwardToBackend(payload) {
  if (!WEBHOOK_URL) {
    console.warn("[bot] WEBHOOK_URL nao configurado; mensagem ignorada.");
    return;
  }
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-token": BOT_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("[bot] webhook respondeu", response.status, text.slice(0, 300));
    }
  } catch (error) {
    console.error("[bot] falha ao chamar o webhook:", error?.message || error);
    await logEvent("Falha ao chamar o webhook", "error", { message: error?.message || String(error) });
  }
}

async function flushQueue() {
  if (flushing || !sock) return;
  flushing = true;
  try {
    const { data, error } = await supabase
      .from("wa_messages")
      .select("id, body, attempts, conversation_id, wa_conversations(phone)")
      .eq("status", "queued")
      .eq("direction", "outbound")
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) {
      console.error("[bot] erro ao buscar fila:", error.message);
      return;
    }

    for (const row of data || []) {
      const phone = row?.wa_conversations?.phone || "";
      if (!phone) {
        await supabase.from("wa_messages").update({ status: "failed", error: "Conversa sem telefone" }).eq("id", row.id);
        continue;
      }

      const jid = `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { text: row.body });
        await supabase
          .from("wa_messages")
          .update({ status: "sent", error: "", attempts: (row.attempts || 0) + 1 })
          .eq("id", row.id);
      } catch (sendError) {
        const attempts = (row.attempts || 0) + 1;
        const failed = attempts >= 3;
        await supabase
          .from("wa_messages")
          .update({
            status: failed ? "failed" : "queued",
            attempts,
            error: String(sendError?.message || sendError).slice(0, 300),
          })
          .eq("id", row.id);
        if (failed) {
          await logEvent("Falha no envio da mensagem", "error", {
            message_id: row.id,
            phone,
            message: String(sendError?.message || sendError),
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error("[bot] erro na fila:", error?.message || error);
  } finally {
    flushing = false;
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    markOnline: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        await publishStatus({
          status: "qr",
          qr_code: dataUrl,
          qr_updated_at: new Date().toISOString(),
          phone: connectedPhone,
        });
        console.log("[bot] novo QR gerado.");
      } catch (error) {
        console.error("[bot] falha ao gerar QR:", error?.message || error);
      }
    }

    if (connection === "open") {
      const raw = sock?.user?.id || "";
      connectedPhone = raw.split(":")[0] || raw.split("@")[0] || "";
      await publishStatus({ status: "connected", qr_code: "", phone: connectedPhone });
      await logEvent("Bot conectado ao WhatsApp", "info", { phone: connectedPhone });
      console.log("[bot] conectado como", connectedPhone);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log("[bot] conexao fechada. codigo:", statusCode, "logout:", loggedOut);

      if (loggedOut) {
        await publishStatus({ status: "disconnected", qr_code: "", phone: "" });
        await logEvent("Sessao do WhatsApp encerrada (logout)", "warn", {});
      } else {
        await publishStatus({ status: "connecting", phone: connectedPhone });
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          startBot().catch((error) => console.error("[bot] falha ao reconectar:", error?.message || error));
        }, 4000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg?.message || msg.key?.fromMe) continue;
      const jid = msg.key?.remoteJid || "";
      if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue;

      const text = extractText(msg.message).trim();
      if (!text) continue;

      await forwardToBackend({
        message_id: msg.key.id,
        phone: jid.split("@")[0],
        push_name: msg.pushName || "",
        text,
        timestamp: Number(msg.messageTimestamp || Date.now() / 1000),
        is_group: false,
      });
    }
  });

  return sock;
}

const app = express();

app.get("/", (request, response) => {
  response.json({
    service: "whatsapp-ia-bot",
    version: BOT_VERSION,
    status: currentStatus,
    phone: connectedPhone || null,
  });
});

app.get("/health", (request, response) => {
  response.json({ ok: true, status: currentStatus, version: BOT_VERSION, phone: connectedPhone || null });
});

app.listen(PORT, () => {
  console.log(`[bot] servico ouvindo na porta ${PORT}`);
});

setInterval(() => flushQueue(), SEND_INTERVAL_MS);
setInterval(() => publishStatus({ phone: connectedPhone }), HEARTBEAT_MS);

publishStatus({ status: "connecting", qr_code: "", phone: "" }).then(() => {
  startBot().catch((error) => {
    console.error("[bot] falha ao iniciar:", error?.message || error);
    publishStatus({ status: "error", qr_code: "" });
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[bot] promise rejeitada:", reason);
});
process.on("SIGTERM", async () => {
  console.log("[bot] encerrando...");
  try {
    await publishStatus({ status: "disconnected" });
  } catch {
    /* ignore */
  }
  process.exit(0);
});
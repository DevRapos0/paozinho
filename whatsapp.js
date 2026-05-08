const axios = require('axios');

const BASE_URL = process.env.EVOLUTION_API_URL  || 'http://localhost:8080';
const API_KEY  = process.env.EVOLUTION_API_KEY   || '';
const INSTANCE = process.env.EVOLUTION_INSTANCE  || 'paocalert';

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
  timeout: 15000,
});

async function getInstanceStatus() {
  try {
    const { data } = await api.get(`/instance/connectionState/${INSTANCE}`);
    return { ok: data?.instance?.state === 'open', state: data?.instance?.state || 'unknown', raw: data };
  } catch (err) {
    return { ok: false, state: 'error', error: err.message };
  }
}

async function createInstance() {
  try {
    const { data } = await api.post('/instance/create', { instanceName: INSTANCE, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
    return { ok: true, data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    if (msg?.includes('already') || msg?.includes('exist')) return { ok: true, exists: true };
    return { ok: false, error: msg };
  }
}

async function getQRCode() {
  try {
    const { data } = await api.get(`/instance/connect/${INSTANCE}`);
    return { ok: true, base64: data?.base64 || null, code: data?.code || null };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

// Compatível com Evolution API v1.8.x
async function enviarMensagem(numero, texto) {
  const num = numero.replace(/\D/g, '');
  const payloads = [
    { number: `${num}@s.whatsapp.net`, options: { delay: 1200, presence: 'composing' }, textMessage: { text: texto } },
    { number: num, options: { delay: 1200 }, textMessage: { text: texto } },
    { number: num, text: texto, delay: 1200 },
  ];
  for (const payload of payloads) {
    try {
      const { data } = await api.post(`/message/sendText/${INSTANCE}`, payload);
      return { ok: true, messageId: data?.key?.id || data?.messageId || null, raw: data };
    } catch (err) {
      const status = err.response?.status;
      if (status !== 400 && status !== 422) {
        return { ok: false, error: err.response?.data?.message || err.response?.data?.error || err.message };
      }
    }
  }
  return { ok: false, error: 'Bad Request em todos os formatos de payload' };
}

// Configurar webhook — v1.8.x formato correto (url direto no root)
async function configurarWebhook(webhookUrl) {
  const body = {
    url: webhookUrl,
    enabled: true,
    webhookByEvents: false,
    webhookBase64: false,
    events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
  };

  try {
    const { data } = await api.post(`/webhook/set/${INSTANCE}`, body);
    console.log('[Webhook] Configurado:', webhookUrl);
    return { ok: true, data };
  } catch (err) {
    const errMsg = err.response?.data?.message || JSON.stringify(err.response?.data) || err.message;
    console.error('[Webhook] Erro:', errMsg);
    return { ok: false, error: errMsg };
  }
}

function buildMensagem(template, { nome = 'Cliente', padariaNome = 'Padaria' } = {}) {
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return template
    .replace(/{nome}/g, nome)
    .replace(/{padaria}/g, padariaNome)
    .replace(/{hora}/g, hora);
}

module.exports = { getInstanceStatus, createInstance, getQRCode, enviarMensagem, configurarWebhook, buildMensagem, INSTANCE };

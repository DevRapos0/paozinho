const express = require('express');
const router  = express.Router();
const { Clientes } = require('../db');
const { enviarMensagem } = require('../whatsapp');

const p = (v) => (typeof v?.then === 'function' ? v : Promise.resolve(v));
const KEYWORD_CADASTRO    = (process.env.KEYWORD_CADASTRO    || 'quero receber alertas').toLowerCase();
const KEYWORD_DESCADASTRO = (process.env.KEYWORD_DESCADASTRO || 'parar alertas').toLowerCase();
const PADARIA_NOME        = process.env.PADARIA_NOME || 'Padaria';

// Buffer de logs em memória (últimos 200)
const logsBuffer = [];
const sseClients = new Set();

function addLog(level, msg, data = null) {
  const entry = {
    ts: new Date().toISOString(),
    level, // 'info' | 'ok' | 'warn' | 'error' | 'webhook'
    msg,
    data: data ? JSON.stringify(data).slice(0, 300) : null,
  };
  logsBuffer.push(entry);
  if (logsBuffer.length > 200) logsBuffer.shift();

  // Envia para todos os clientes SSE conectados
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try { client.write(line); } catch (e) { sseClients.delete(client); }
  }

  console.log(`[${level.toUpperCase()}] ${msg}${data ? ' ' + JSON.stringify(data).slice(0,100) : ''}`);
}

// GET /api/logs — Server-Sent Events (stream ao vivo)
router.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Envia histórico
  for (const entry of logsBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// GET /api/logs/history — histórico JSON
router.get('/logs/history', (req, res) => {
  res.json({ ok: true, data: logsBuffer });
});

// POST /api/webhook/evolution
router.post('/evolution', async (req, res) => {
  res.json({ ok: true });

  const body = req.body;
  addLog('webhook', `Evento recebido: ${body?.event || 'desconhecido'}`, { event: body?.event, instance: body?.instance });

  try {
    // Aceita tanto 'messages.upsert' quanto 'MESSAGES_UPSERT'
    const event = (body?.event || '').toLowerCase().replace('.', '_');
    if (event !== 'messages_upsert') {
      addLog('info', `Evento ignorado: ${body?.event}`);
      return;
    }

    // Suporta diferentes estruturas da Evolution API v1 e v2
    const msgs = body?.data?.messages
      || body?.data
      || (Array.isArray(body?.data) ? body.data : null)
      || [];

    const msgArray = Array.isArray(msgs) ? msgs : [msgs];

    addLog('info', `Mensagens recebidas: ${msgArray.length}`);

    for (const msg of msgArray) {
      if (!msg) continue;

      // Ignora mensagens enviadas por nós
      if (msg?.key?.fromMe) {
        addLog('info', 'Ignorando mensagem própria');
        continue;
      }

      // Ignora grupos
      if (msg?.key?.remoteJid?.includes('@g.us')) {
        addLog('info', 'Ignorando mensagem de grupo');
        continue;
      }

      const jid    = msg?.key?.remoteJid || '';
      const numero = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      const texto  = (
        msg?.message?.conversation
        || msg?.message?.extendedTextMessage?.text
        || msg?.message?.imageMessage?.caption
        || ''
      ).toLowerCase().trim();

      addLog('webhook', `Mensagem de ${numero}: "${texto}"`);

      if (!numero || !texto) {
        addLog('warn', `Número ou texto vazio — numero="${numero}" texto="${texto}"`);
        continue;
      }

      // ── Cadastro ────────────────────────────────────────────────────
      if (texto.includes(KEYWORD_CADASTRO)) {
        addLog('info', `Keyword de cadastro detectada de ${numero}`);

        const existente = await p(Clientes.buscarPorNumero(numero));

        if (existente && existente.ativo) {
          addLog('info', `${numero} já está cadastrado e ativo`);
          await enviarMensagem(numero, `✅ Você já está na nossa lista! Sempre que sair pão fresquinho da *${PADARIA_NOME}*, você será avisado. 🍞`);
          continue;
        }

        const nome = msg?.pushName || msg?.verifiedBizName || 'Cliente';

        if (existente && !existente.ativo) {
          await p(Clientes.atualizar({ id: existente.id, nome, ativo: 1 }));
          addLog('ok', `Cliente reativado: ${nome} (${numero})`);
        } else {
          await p(Clientes.inserir({ nome, numero, origem: 'qrcode' }));
          addLog('ok', `Novo cliente cadastrado: ${nome} (${numero})`);
        }

        await enviarMensagem(numero,
          `🍞 *Olá, ${nome}!* Você foi cadastrado para receber alertas de pão quentinho da *${PADARIA_NOME}*!\n\nAssim que sair fornada, você recebe uma mensagem aqui. 🔥\n\n_Para cancelar: responda "parar alertas"_`
        );
        addLog('ok', `Mensagem de boas-vindas enviada para ${nome} (${numero})`);
        continue;
      }

      // ── Descadastro ─────────────────────────────────────────────────
      if (texto.includes(KEYWORD_DESCADASTRO)) {
        await p(Clientes.desativarPorNumero(numero));
        await enviarMensagem(numero, `😢 Você foi removido da lista de alertas da *${PADARIA_NOME}*. Para voltar, escaneie o QR Code novamente. 👋`);
        addLog('ok', `Cliente descadastrado: ${numero}`);
        continue;
      }

      addLog('info', `Mensagem de ${numero} não contém keyword — ignorando`);
    }
  } catch (err) {
    addLog('error', `Erro no webhook: ${err.message}`);
  }
});

module.exports = { router, addLog };

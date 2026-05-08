require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const rateLimit   = require('express-rate-limit');
const QRCode      = require('qrcode');

const { Clientes, Fornadas, Envios, Config } = require('./db');
const {
  getInstanceStatus,
  createInstance,
  getQRCode,
  configurarWebhook,
  INSTANCE,
} = require('./whatsapp');

// Routes
const clientesRouter = require('./routes/clientes');
const fornadaRouter  = require('./routes/fornada');
const { router: webhookRouter, addLog } = require('./routes/webhook');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares ─────────────────────────────────────────────────────────

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// Rate limit para rota de disparo (máx 10/min)
const fornadaLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, error: 'Muitas requisições. Aguarde 1 minuto.' },
});

// Rate limit para botão IoT (mais restrito)
const iotLimit = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Muitas requisições do botão físico.' },
});

// Servir frontend estático
const FRONTEND_DIR = path.join(process.cwd(), 'frontend');
app.use(express.static(FRONTEND_DIR));

// ─── API Routes ──────────────────────────────────────────────────────────

app.use('/api/clientes', clientesRouter);
app.use('/api/fornada',  fornadaLimit, fornadaRouter);
app.use('/api/webhook',  webhookRouter);
app.get('/api/logs', (req, res) => webhookRouter.stack && res.redirect('/api/webhook/logs'));

// ─── Rota do Botão IoT (ESP8266) ─────────────────────────────────────────
//
// GET ou POST /api/iot/fornada?token=SEU_TOKEN
// Chamado pelo ESP8266 quando o botão físico é pressionado
//
app.all('/api/iot/fornada', iotLimit, async (req, res) => {
  const token = req.query.token || req.body?.token || req.headers['x-iot-token'];

  if (!process.env.IOT_SECRET || token !== process.env.IOT_SECRET) {
    return res.status(401).json({ ok: false, error: 'Token inválido.' });
  }

  // Delega para o mesmo handler de fornada, com origem 'iot'
  req.body = { ...req.body, origem: 'iot' };

  // Chama internamente a rota de fornada
  try {
    const clientes = Clientes.listarAtivos.all();
    if (clientes.length === 0) {
      return res.json({ ok: false, error: 'Nenhum cliente ativo.', blink: 3 });
    }

    res.json({
      ok:      true,
      total:   clientes.length,
      message: `Disparo IoT iniciado para ${clientes.length} clientes`,
      blink:   1, // sinal para ESP8266 piscar LED de sucesso
    });

    // Disparo assíncrono (reutiliza a lógica de fornada)
    const { enviarMensagem, buildMensagem } = require('./whatsapp');
    const template    = Config.getValor('mensagem_padrao') || '🍞 Saiu fornada!';
    const padariaNome = process.env.PADARIA_NOME || Config.getValor('padaria_nome') || 'Padaria';

    const fornInfo  = Fornadas.inserir.run({ mensagem: template, origem: 'iot' });
    const fornadaId = fornInfo.lastInsertRowid;

    let ok = 0, erros = 0;

    for (const c of clientes) {
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      const texto  = buildMensagem(template, { nome: c.nome, padariaNome });
      const result = await enviarMensagem(c.numero, texto);

      const envioInfo = Envios.inserir.run({ fornada_id: fornadaId, cliente_id: c.id, numero: c.numero });
      Envios.atualizarStatus.run({
        id:         envioInfo.lastInsertRowid,
        status:     result.ok ? 'ok' : 'erro',
        erro_msg:   result.ok ? null : (result.error || null),
        message_id: result.ok ? (result.messageId || null) : null,
      });

      if (result.ok) ok++; else erros++;
    }

    Fornadas.atualizarContadores.run({ id: fornadaId, total: clientes.length, ok, erros });
    console.log(`[IoT Fornada #${fornadaId}] ✅ ${ok} enviados, ❌ ${erros} erros`);
  } catch (err) {
    console.error('[IoT] Erro:', err.message);
  }
});



// ─── Logs ao vivo (Server-Sent Events) ───────────────────────────────────

const logClients = new Set();
const logBuffer  = [];

function emitLog(level, msg) {
  const entry = { t: new Date().toLocaleTimeString('pt-BR'), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > 200) logBuffer.shift();
  const line = 'data: ' + JSON.stringify(entry) + '

';
  logClients.forEach(res => { try { res.write(line); } catch(e) { logClients.delete(res); } });
}

// Intercepta console.log e console.error
const _log   = console.log.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => { _log(...a);   emitLog('info',  a.join(' ')); };
console.error = (...a) => { _error(...a); emitLog('error', a.join(' ')); };

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Envia buffer dos últimos logs
  logBuffer.forEach(e => res.write('data: ' + JSON.stringify(e) + '

'));

  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

app.get('/api/logs/history', (req, res) => {
  res.json({ ok: true, data: logBuffer });
});

// ─── Configurar webhook manualmente ──────────────────────────────────────

app.post('/api/webhook/setup', async (req, res) => {
  const publicUrl = process.env.PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

  if (!publicUrl) {
    return res.status(400).json({ ok: false, error: 'PUBLIC_URL não configurada nas variáveis.' });
  }

  const webhookUrl = `${publicUrl}/api/webhook/evolution`;
  const wh = await configurarWebhook(webhookUrl);

  res.json({
    ok: wh.ok,
    webhookUrl,
    message: wh.ok ? 'Webhook configurado com sucesso!' : ('Erro: ' + wh.error),
  });
});

// ─── Status geral ─────────────────────────────────────────────────────────

const p = (v) => (typeof v?.then === 'function' ? v : Promise.resolve(v));

app.get('/api/status', async (req, res) => {
  const whatsapp = await getInstanceStatus();
  const totalClientes  = (await p(Clientes.total())).n;
  const enviadosHoje   = (await p(Envios.totalEnviadosHoje())).n;
  const fornadasHoje   = (await p(Fornadas.totalHoje())).n;
  const mensagemPadrao = await p(Config.getValor('mensagem_padrao'));
  const padariaNome    = process.env.PADARIA_NOME || await p(Config.getValor('padaria_nome'));

  res.json({
    ok: true,
    whatsapp,
    stats: { totalClientes, enviadosHoje, fornadasHoje },
    config: { mensagemPadrao, padariaNome, instance: INSTANCE },
  });
});

// ─── QR Code da instância WhatsApp ────────────────────────────────────────

app.get('/api/whatsapp/qr', async (req, res) => {
  const qr = await getQRCode();
  if (!qr.ok) return res.status(500).json(qr);

  if (qr.base64) {
    return res.json({ ok: true, base64: qr.base64 });
  }

  // Converte code em QR image
  if (qr.code) {
    const png = await QRCode.toDataURL(qr.code);
    return res.json({ ok: true, base64: png });
  }

  res.json({ ok: false, error: 'QR Code não disponível. WhatsApp já pode estar conectado.' });
});

// ─── QR Code de cadastro de cliente ──────────────────────────────────────

app.get('/api/qrcode-cadastro', async (req, res) => {
  const numero  = (process.env.PADARIA_NUMERO || '').replace(/\D/g, '');
  const keyword = process.env.KEYWORD_CADASTRO || 'Quero receber alertas';
  const url     = `https://wa.me/${numero}?text=${encodeURIComponent(keyword)}`;
  const png     = await QRCode.toDataURL(url, { width: 300, margin: 2 });

  res.json({ ok: true, base64: png, url });
});

// ─── Salvar config ────────────────────────────────────────────────────────

app.post('/api/config', async (req, res) => {
  const { mensagem_padrao, padaria_nome } = req.body;
  if (mensagem_padrao) await p(Config.setValor('mensagem_padrao', mensagem_padrao));
  if (padaria_nome)    await p(Config.setValor('padaria_nome', padaria_nome));
  res.json({ ok: true });
});

// ─── Fallback SPA ─────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'frontend', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🍞 PãoAlert rodando na porta ${PORT}`);
  console.log(`   Instância WhatsApp: ${INSTANCE}`);
  console.log(`   Evolution API: ${process.env.EVOLUTION_API_URL || 'não configurada'}`);

  // Tenta criar instância se não existir
  const created = await createInstance();
  if (created.ok && !created.exists) {
    console.log('   ✅ Instância WhatsApp criada!');
  } else if (created.exists) {
    console.log('   ✅ Instância WhatsApp já existe.');
  } else {
    console.log('   ⚠️  Evolution API indisponível — configure EVOLUTION_API_URL nas variáveis.');
  }

  // Webhook: usa PUBLIC_URL se definido (Railway), senão tenta localhost
  const publicUrl = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;

  if (publicUrl) {
    const webhookUrl = `${publicUrl}/api/webhook/evolution`;
    const wh = await configurarWebhook(webhookUrl);
    if (wh.ok) {
      console.log(`   ✅ Webhook configurado: ${webhookUrl}`);
    } else {
      console.log(`   ⚠️  Webhook não configurado: ${wh.error}`);
    }
  } else {
    console.log('   ⚠️  PUBLIC_URL não definida — webhook não configurado automaticamente.');
    console.log('   → Adicione a variável PUBLIC_URL=https://sua-url.railway.app nas Variables do Railway.');
  }

  console.log(`\n   ✅ Servidor pronto!\n`);
});
